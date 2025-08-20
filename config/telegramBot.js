import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import User from '../models/userdata.js';
import Booking from '../models/bookingHistory.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });
const webAppUrl = 'https://barbershop-telegram-bot.netlify.app/';
const pendingRejections = new Map();
// start the bot
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    bot.sendMessage(chatId, "Welcome! Please share your phone number to register:", {
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
    });
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

        bot.sendMessage(chatId, "✅ You are now registered! You can open the app below.", {
            reply_markup: {
                keyboard: [
                    [{
                        text: "🚀 Tezkor Namangan",
                        web_app: { url: webAppUrl } // <-- THIS IS THE MAGIC
                    }]
                ],
                resize_keyboard: true
            }
        });

    } catch (error) {
        // This is the most important log. Let's see the full error.
        console.error("❌ DATABASE ERROR:", error);
        bot.sendMessage(chatId, "❌ Something went wrong with the registration. Please try again later.");
    }
});

// order management on bot
export const sendBookingRequestToAdmin = async (booking) => {
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const formattedTime = new Date(booking.requestedTime).toLocaleDateString("en-US", dateOptions);
  
  const message = `
    📢 *New Booking Request* 📢
    *Shop:* ${booking.shopName}
    *User Name:* ${booking.userName}
    *User:* @${booking.userTelegramUsername || booking.userTelegramId}
    *User Number:* ${booking.userNumber}
    *Time:* ${formattedTime}
  `;
  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Confirm', callback_data: `confirm_${booking._id}` }, { text: '❌ Reject', callback_data: `reject_${booking._id}` }],
      ],
    },
  };
  await bot.sendMessage(adminChatId, message, options);
};
// order acceptance 
bot.on('callback_query', async (callbackQuery) => {
  const { data, message } = callbackQuery;
  const [action, bookingId] = data.split('_');

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    bot.answerCallbackQuery(callbackQuery.id);
    return bot.editMessageText('Error: This booking was not found.', {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
  }

  // --- FIX: Re-create the original message content to reuse it ---
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const formattedTime = new Date(booking.requestedTime).toLocaleDateString("en-US", dateOptions);
  const originalMessageText = `
    📢 *New Booking Request* 📢
    *Shop:* ${booking.shopName}
    *User Name:* ${booking.userName}
    *User:* @${booking.userTelegramUsername || booking.userTelegramId}
    *User Number:* ${booking.userNumber}
    *Time:* ${formattedTime}
  `;

  if (action === 'confirm') {
    booking.status = 'confirmed';
    await booking.save();
    
    const userMessage = `✅ Your booking for *${booking.shopName}* at ${new Date(booking.requestedTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} has been confirmed!`;
    await bot.sendMessage(booking.userTelegramId, userMessage, { parse_mode: 'Markdown' });

    // --- FIX: Edit the message text to show the new status AND remove the buttons ---
    bot.editMessageText(`${originalMessageText}\n\n*Status: CONFIRMED ✅*`, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      parse_mode: 'Markdown',
      // By not including a reply_markup, the buttons are removed automatically
    });
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Booking Confirmed!' });

  } else if (action === 'reject') {
    // --- FIX: Immediately edit the message to remove buttons and show a "waiting" state ---
    bot.editMessageText(`${originalMessageText}\n\n*Status: PENDING REASON... ⏳*`, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      parse_mode: 'Markdown',
    });
    
    // Store both the bookingId and the original message_id to edit later
    pendingRejections.set(message.chat.id.toString(), { bookingId, originalMessageId: message.message_id });
    
    await bot.sendMessage(message.chat.id, 'Please provide a reason for rejecting this booking.', {
      reply_markup: { force_reply: true },
    });
    bot.answerCallbackQuery(callbackQuery.id);
  }
});
// order rejection
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  
  if (msg.reply_to_message && pendingRejections.has(chatId)) {
    const { bookingId, originalMessageId } = pendingRejections.get(chatId);
    const reason = msg.text;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) return;

    booking.status = 'rejected';
    booking.rejectionReason = reason;
    await booking.save();
    
    const userMessage = `❌ Unfortunately, your booking for *${booking.shopName}* could not be confirmed.\n\n*Reason:* ${reason}`;
    await bot.sendMessage(booking.userTelegramId, userMessage, { parse_mode: 'Markdown' });
    
    await bot.sendMessage(chatId, 'Rejection reason sent to the user.');
    pendingRejections.delete(chatId);

    // --- FIX: Now we edit the *original* message with the final rejection status ---
    const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const formattedTime = new Date(booking.requestedTime).toLocaleDateString("en-US", dateOptions);
    const finalMessageText = `
      📢 *New Booking Request* 📢
      *Shop:* ${booking.shopName}
      *User Name:* ${booking.userName}
      *User:* @${booking.userTelegramUsername || booking.userTelegramId}
      *User Number:* ${booking.userNumber}
      *Time:* ${formattedTime}
      \n\n*Status: REJECTED ❌*\n*Reason:* ${reason}
    `;

    bot.editMessageText(finalMessageText, {
        chat_id: chatId,
        message_id: originalMessageId, // Use the saved message ID
        parse_mode: 'Markdown',
    });
  }
});

export default bot;
