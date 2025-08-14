import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import User from '../models/userdata.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });
const webAppUrl = 'https://barbershop-telegram-bot.netlify.app/';
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


export const sendBookingRequestToAdmin = async (booking) => {
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const formattedTime = new Date(booking.requestedTime).toLocaleDateString("en-US", dateOptions);
  
  const message = `
    📢 *New Booking Request* 📢
    *Shop:* ${booking.shopName}
    *User:* @${booking.userTelegramUsername || booking.userTelegramId}
    *User Number:*${booking.userNumber}
    *User Telegram number:* ${booking.userTelegramNumber}
    *Time:* ${formattedTime}
  `;

  // Create "Confirm" and "Reject" buttons
  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `confirm_${booking._id}` },
          { text: '❌ Reject', callback_data: `reject_${booking._id}` },
        ],
      ],
    },
  };

  await bot.sendMessage(adminChatId, message, options);
};

// --- Listener for when the admin clicks a button ---
bot.on('callback_query', async (callbackQuery) => {
  const { data, message } = callbackQuery;
  const [action, bookingId] = data.split('_');
  
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    bot.sendMessage(adminChatId, 'Error: Booking not found.');
    return;
  }
  
  let newStatus;
  let userMessage;
  
  if (action === 'confirm') {
    newStatus = 'confirmed';
    userMessage = `✅ Your booking for *${booking.shopName}* at ${new Date(booking.requestedTime).toLocaleTimeString()} has been confirmed!`;
  } else if (action === 'reject') {
    newStatus = 'rejected';
    userMessage = `❌ Unfortunately, your booking for *${booking.shopName}* at ${new Date(booking.requestedTime).toLocaleTimeString()} could not be confirmed.`;
  } else {
    return;
  }
  
  // Update the booking status in the database
  booking.status = newStatus;
  await booking.save();
  
  // Notify the user of the result
  await bot.sendMessage(booking.userTelegramId, userMessage, { parse_mode: 'Markdown' });
  
  // Update the original admin message to show the action was taken
  bot.editMessageText(`Action taken: *${newStatus.toUpperCase()}*`, {
    chat_id: message.chat.id,
    message_id: message.message_id,
    parse_mode: 'Markdown',
  });
});

export default bot;
