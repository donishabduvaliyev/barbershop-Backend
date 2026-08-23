import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import User from '../models/userdata.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import ServicesModel from '../models/shopData.js';
import { DIVIDER, formatDateTime } from '../utils/telegramFormat.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: false });
let pollingStarted = false;

export const startBot = () => {
  if (pollingStarted) return;
  if (!token) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set — customer bot disabled.');
    return;
  }
  pollingStarted = true;
  // startPolling() resolves once Telegram has actually accepted the
  // long-poll connection — logging here (not just calling it) is the only
  // way to tell from a host's log window whether the bot is truly live, as
  // opposed to having silently failed to start (bad token, network issue).
  bot.startPolling()
    .then(() => console.log('✅ Customer bot polling started.'))
    .catch((err) => console.error('❌ Customer bot failed to start polling:', err.message));
};

// Without an explicit listener, a 409 (another instance already polling
// this same token — see DISABLE_TELEGRAM_POLLING in server.js) or any other
// polling failure happens silently on some hosts instead of showing up in
// the log window, which looks identical to "nothing is happening" from the
// customer's side.
bot.on('polling_error', (err) => {
  console.error('❌ Customer bot polling error:', err.message);
});

const webAppUrl = 'https://barbershop-telegram-bot.netlify.app';

// start the bot
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

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

// Called by services/bookingActions.js once a confirmed booking's time has
// passed — kicks off the rating flow via inline star buttons.
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

// customer star-rating flow — the only callback/message handling left on
// this bot. Confirm/reject/rejection-reason handling now lives entirely on
// the shop-control bot (config/shopControlBot.js), since only shop owners
// see those buttons.
bot.on('callback_query', async (callbackQuery) => {
  try {
    const { data, message } = callbackQuery;
    const [action, bookingId, starsRaw] = data.split('_');
    if (action !== 'rate' && action !== 'staffrate') return;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      bot.answerCallbackQuery(callbackQuery.id);
      return bot.editMessageText('⚠️ This booking could not be found.', {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }

    if (action === 'rate') {
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
    console.error('Error handling rating callback:', err);
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Something went wrong.' }).catch(() => {});
  }
});

export default bot;
