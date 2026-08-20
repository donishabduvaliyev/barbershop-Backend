import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import User from '../models/userdata.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import ServicesModel from '../models/shopData.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: false });
let pollingStarted = false;

export const startBot = () => {
  if (!pollingStarted) {
    pollingStarted = true;
    bot.startPolling();
  }
};

const webAppUrl = 'https://barbershop-telegram-bot.netlify.app';
const pendingRejections = new Map();
export const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

export const formatDateTime = (date) =>
  new Date(date).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

// Single source of truth for the admin-facing booking card, reused for the
// initial post and every subsequent status edit so the layout never drifts.
const formatBookingCard = (booking, statusLine) => {
  const lines = [
    '💈 *TEZKOR* · New Booking Request',
    DIVIDER,
    `🏪 *Shop:*  ${booking.shopName}`,
    `👤 *Client:*  ${booking.userName}`,
    `🔗 *Telegram:*  @${booking.userTelegramUsername || booking.userTelegramId}`,
    `📞 *Phone:*  ${booking.userNumber}`,
    `🗓 *Time:*  ${formatDateTime(booking.requestedTime)}`,
  ];
  if (booking.staffName) {
    lines.push(`✂️ *Barber:*  ${booking.staffName}`);
  }
  if (statusLine) {
    lines.push(DIVIDER, statusLine);
  }
  return lines.join('\n');
};

// start the bot
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    bot.sendMessage(
        chatId,
        '👋 *Welcome to Tezkor*\n\nBook barbershops, salons and spas in seconds — right from Telegram.\n\nShare your phone number to get started:',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{
                        text: "📱 Send My Phone Number",
                        request_contact: true,
                    }],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            },
        }
    );
});
// add contact to db
bot.on('contact', async (msg) => {
    console.log("Received contact information."); // <-- LOG 1
    const chatId = msg.chat.id;
    const contact = msg.contact;

    if (msg.from.id !== contact.user_id) {
        return bot.sendMessage(chatId, "Please share your *own* phone number.", { parse_mode: 'Markdown' });
    }

    const userData = {
        telegramId: contact.user_id.toString(),
        name: `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
        username: msg.from.username || '',
        phone: contact.phone_number,
        avatar: '',
    };

    console.log("Constructed User Data:", userData);

    try {
        const photos = await bot.getUserProfilePhotos(contact.user_id, { limit: 1 });
        if (photos && photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            // The getFileLink can cause ECONNRESET, so we are careful here
            const fileLink = await bot.getFileLink(fileId);
            userData.avatar = fileLink;
        }
    } catch (photoError) {
        // Log the error but don't stop the process
        console.error("Could not fetch profile photo. Continuing without it.", photoError.message);
    }

    try {
        console.log("Attempting to find user in DB..."); // <-- LOG 4
        let user = await User.findOne({ telegramId: userData.telegramId });

        if (user) {
            console.log("User found. Attempting to update..."); // <-- LOG 5
            await User.updateOne({ telegramId: userData.telegramId }, { $set: userData });
            console.log("User updated successfully in DB."); // <-- LOG 6
        } else {
            console.log("User not found. Attempting to create new user..."); // <-- LOG 7
            const newUser = new User(userData);
            await newUser.save();
            console.log("New user saved successfully in DB."); // <-- LOG 8
        }

        bot.sendMessage(
            chatId,
            "✨ *You're all set!*\n\nYour account is ready — tap below to start booking.",
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [
                        [{
                            text: "🚀 Open Tezkor",
                            web_app: { url: webAppUrl } // <-- THIS IS THE MAGIC
                        }]
                    ],
                    resize_keyboard: true
                }
            }
        );

    } catch (error) {
        // This is the most important log. Let's see the full error.
        console.error("❌ DATABASE ERROR:", error);
        bot.sendMessage(chatId, "❌ Something went wrong with the registration. Please try again later.");
    }
});

// order management on bot
export const sendBookingRequestToAdmin = async (booking) => {
  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Confirm', callback_data: `confirm_${booking._id}` }, { text: '❌ Reject', callback_data: `reject_${booking._id}` }],
      ],
    },
  };
  await bot.sendMessage(adminChatId, formatBookingCard(booking), options);
};
// A booking's userTelegramId can belong to a chat the bot can no longer
// message (user blocked the bot, deleted their account, or — historically,
// before auth was enforced — was never a real chat at all). None of that
// should ever be allowed to crash the bot or block the admin-facing flow.
export const notifyUser = async (chatId, text, extra = {}) => {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    console.error(`Failed to message Telegram user ${chatId}:`, err.message);
  }
};

const buildStarKeyboard = (prefix, bookingId) => ({
  inline_keyboard: [
    [1, 2, 3, 4, 5].map((n) => ({ text: '⭐'.repeat(n), callback_data: `${prefix}_${bookingId}_${n}` })),
  ],
});

// Called by jobs/reminders.js as bookings cross the 24h/3h-before thresholds.
export const sendReminder = async (booking, whenLabel) => {
  const message = [
    '⏰ *Appointment Reminder*',
    DIVIDER,
    `Don't forget — your visit to *${booking.shopName}* is ${whenLabel}.`,
    `🗓 ${formatDateTime(booking.requestedTime)}`,
    booking.staffName ? `✂️ *Barber:* ${booking.staffName}` : null,
  ].filter(Boolean).join('\n');
  await notifyUser(booking.userTelegramId, message);
};

// Called by jobs/reminders.js once a confirmed booking's time has passed —
// kicks off the rating flow via inline star buttons.
export const sendRatingRequest = async (booking) => {
  const message = [
    '💈 *How was your visit?*',
    DIVIDER,
    `Tell us how your appointment at *${booking.shopName}* went:`,
  ].join('\n');
  await notifyUser(booking.userTelegramId, message, {
    reply_markup: buildStarKeyboard('rate', booking._id),
  });
};

// order acceptance
bot.on('callback_query', async (callbackQuery) => {
  try {
    const { data, message } = callbackQuery;
    const [action, bookingId, starsRaw] = data.split('_');

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      bot.answerCallbackQuery(callbackQuery.id);
      return bot.editMessageText('⚠️ This booking could not be found.', {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }

    if (action === 'confirm') {
      booking.status = 'confirmed';
      await booking.save();

      const userMessage = [
        '✅ *Booking Confirmed*',
        DIVIDER,
        `Your appointment at *${booking.shopName}* is set for 🗓 ${formatDateTime(booking.requestedTime)}.`,
        '',
        'See you there! 💈',
      ].join('\n');
      await notifyUser(booking.userTelegramId, userMessage);

      // Edit the admin's card in place — omitting reply_markup removes the buttons.
      bot.editMessageText(formatBookingCard(booking, '🟢 *CONFIRMED*'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Booking confirmed!' });

    } else if (action === 'reject') {
      bot.editMessageText(formatBookingCard(booking, '🟡 *Awaiting rejection reason…*'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });

      // Store both the bookingId and the original message_id to edit later
      pendingRejections.set(message.chat.id.toString(), { bookingId, originalMessageId: message.message_id });

      await bot.sendMessage(message.chat.id, '✍️ Please reply with a reason for rejecting this booking.', {
        reply_markup: { force_reply: true },
      });
      bot.answerCallbackQuery(callbackQuery.id);

    } else if (action === 'rate') {
      const stars = parseInt(starsRaw, 10);

      // A customer can only tap one of these buttons once — Telegram doesn't
      // remove buttons on tap, so guard against a double-submit re-editing
      // the same review (editMessageText below removes them from the UI,
      // but a race between two rapid taps could still land here twice).
      const existing = await Review.findOne({ bookingId: booking._id });
      if (!existing) {
        await Review.create({ bookingId: booking._id, shopId: booking.shopId, userTelegramId: booking.userTelegramId, rating: stars });

        const shop = await ServicesModel.findById(booking.shopId).select('rating reviewsCount');
        if (shop) {
          const newRating = (shop.rating * shop.reviewsCount + stars) / (shop.reviewsCount + 1);
          shop.rating = Math.round(newRating * 10) / 10;
          shop.reviewsCount += 1;
          await shop.save();
        }
      }

      bot.editMessageText(`💈 *How was your visit?*\n${DIVIDER}\nThanks for your feedback! You rated it ${'⭐'.repeat(stars)}`, {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });

      if (booking.staffId && booking.staffName && !existing?.staffRating) {
        await bot.sendMessage(message.chat.id, `And how was *${booking.staffName}*?`, {
          parse_mode: 'Markdown',
          reply_markup: buildStarKeyboard('staffrate', booking._id),
        });
      }
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Thanks for rating!' });

    } else if (action === 'staffrate') {
      const stars = parseInt(starsRaw, 10);

      const review = await Review.findOneAndUpdate(
        { bookingId: booking._id },
        { $set: { staffRating: stars, staffId: booking.staffId } },
        { upsert: true }
      );

      // Only fold this into the staff member's running average once per booking.
      if (booking.staffId && !review?.staffRating) {
        const shop = await ServicesModel.findById(booking.shopId).select('staff');
        const staffMember = shop?.staff?.id(booking.staffId);
        if (staffMember) {
          const newStaffRating = (staffMember.rating * staffMember.reviewsCount + stars) / (staffMember.reviewsCount + 1);
          staffMember.rating = Math.round(newStaffRating * 10) / 10;
          staffMember.reviewsCount += 1;
          await shop.save();
        }
      }

      bot.editMessageText(`Thanks! You rated *${booking.staffName}* ${'⭐'.repeat(stars)}`, {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Thanks!' });
    }
  } catch (err) {
    console.error('Error handling booking callback:', err);
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Something went wrong.' }).catch(() => {});
  }
});
// order rejection
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id.toString();

    if (msg.reply_to_message && pendingRejections.has(chatId)) {
      const { bookingId, originalMessageId } = pendingRejections.get(chatId);
      const reason = msg.text;

      const booking = await Booking.findById(bookingId);
      if (!booking) return;

      booking.status = 'rejected';
      booking.rejectionReason = reason;
      await booking.save();

      const userMessage = [
        '❌ *Booking Update*',
        DIVIDER,
        `We couldn't confirm your booking at *${booking.shopName}* for 🗓 ${formatDateTime(booking.requestedTime)}.`,
        '',
        `*Reason:* ${reason}`,
        '',
        'Feel free to pick another time that works for you.',
      ].join('\n');
      await notifyUser(booking.userTelegramId, userMessage);

      await bot.sendMessage(chatId, '✅ Rejection reason sent to the client.');
      pendingRejections.delete(chatId);

      // Edit the original admin card with the final rejection status.
      bot.editMessageText(formatBookingCard(booking, `🔴 *REJECTED*\n*Reason:* ${reason}`), {
          chat_id: chatId,
          message_id: originalMessageId, // Use the saved message ID
          parse_mode: 'Markdown',
      });
    }
  } catch (err) {
    console.error('Error handling rejection reason message:', err);
  }
});

export default bot;
