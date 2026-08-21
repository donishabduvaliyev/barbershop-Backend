// Dedicated bot for shop owners: they use it to log into the admin panel
// (no passwords — Telegram identity is the credential, see routes/adminAuth.js)
// and to receive/confirm/reject their own shop's new bookings. Deliberately
// a separate bot/token from config/telegramBot.js so a customer's chat with
// the booking bot never mixes with an owner's shop-control chat.
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { registerCardEditor } from './notificationBridge.js';
import { confirmBooking, rejectBooking } from '../services/bookingActions.js';
import { DIVIDER, formatBookingCard } from '../utils/telegramFormat.js';

const token = process.env.SHOP_CONTROL_BOT_TOKEN;
const adminPanelUrl = process.env.ADMIN_PANEL_URL || 'http://localhost:5173';
const shopControlBot = new TelegramBot(token, { polling: false });
let pollingStarted = false;

export const startShopControlBot = () => {
  if (!token) {
    console.warn('⚠️ SHOP_CONTROL_BOT_TOKEN not set — shop-control bot disabled.');
    return;
  }
  if (!pollingStarted) {
    pollingStarted = true;
    shopControlBot.startPolling();
  }
};

const dashboardKeyboard = {
  inline_keyboard: [[{ text: '🔐 Open Dashboard', web_app: { url: adminPanelUrl } }]],
};

shopControlBot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shop = await ServicesModel.findOne({ ownerTelegramId: msg.from.id }).select('name');
    if (shop) {
      return shopControlBot.sendMessage(
        chatId,
        `👋 *Welcome back*\n\nManaging *${shop.name?.en || shop.name?.ru || 'your shop'}*. Open your dashboard below:`,
        { parse_mode: 'Markdown', reply_markup: dashboardKeyboard }
      );
    }
    shopControlBot.sendMessage(
      chatId,
      "👋 *Tezkor Shop Control*\n\nThis bot manages your shop's appointments, services, staff and stats.\n\nTo link your shop, send:\n`/claim YOUR_CODE`\n\n(Your shop's claim code is provided when your shop is added to Tezkor.)",
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('shopControlBot /start error:', err);
  }
});

shopControlBot.onText(/\/claim (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();
  try {
    const alreadyLinked = await ServicesModel.findOne({ ownerTelegramId: msg.from.id });
    if (alreadyLinked) {
      return shopControlBot.sendMessage(chatId, `You're already managing *${alreadyLinked.name?.en || 'a shop'}*.`, {
        parse_mode: 'Markdown',
        reply_markup: dashboardKeyboard,
      });
    }

    const shop = await ServicesModel.findOne({ ownerClaimCode: code });
    if (!shop) {
      return shopControlBot.sendMessage(chatId, '❌ Invalid or already-used claim code.');
    }

    shop.ownerTelegramId = msg.from.id;
    shop.ownerClaimCode = null;
    await shop.save();

    shopControlBot.sendMessage(
      chatId,
      `✅ *Shop linked!*\n\nYou're now managing *${shop.name?.en || shop.name?.ru || 'your shop'}*. Open your dashboard below:`,
      { parse_mode: 'Markdown', reply_markup: dashboardKeyboard }
    );
  } catch (err) {
    console.error('shopControlBot /claim error:', err);
    shopControlBot.sendMessage(chatId, '❌ Something went wrong linking your shop. Please try again.');
  }
});

// New-booking notifications now route to the specific shop's owner instead
// of one global admin chat, so each shop only ever sees its own requests.
export const notifyShopOwnerOfNewBooking = async (booking) => {
  const shop = await ServicesModel.findById(booking.shopId).select('ownerTelegramId');
  if (!shop?.ownerTelegramId) {
    console.warn(`Shop ${booking.shopId} has no linked owner — booking ${booking._id} was not posted to Telegram.`);
    return;
  }

  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Confirm', callback_data: `confirm_${booking._id}` }, { text: '❌ Reject', callback_data: `reject_${booking._id}` }],
      ],
    },
  };
  const sent = await shopControlBot.sendMessage(shop.ownerTelegramId, formatBookingCard(booking), options);

  booking.notificationChatId = sent.chat.id;
  booking.notificationMessageId = sent.message_id;
  await booking.save();
};

// Registered with the notification bridge so services/bookingActions.js can
// edit this booking's card in place after a status change, without a
// circular import between this file and bookingActions.js (which this file
// itself imports to run its own button handlers below).
registerCardEditor(async (booking, statusLine) => {
  if (!booking.notificationChatId || !booking.notificationMessageId) return;
  await shopControlBot.editMessageText(formatBookingCard(booking, statusLine), {
    chat_id: booking.notificationChatId,
    message_id: booking.notificationMessageId,
    parse_mode: 'Markdown',
  });
});

const pendingRejections = new Map();

shopControlBot.on('callback_query', async (callbackQuery) => {
  try {
    const { data, message } = callbackQuery;
    const [action, bookingId] = data.split('_');

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      shopControlBot.answerCallbackQuery(callbackQuery.id);
      return shopControlBot.editMessageText('⚠️ This booking could not be found.', {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }

    if (action === 'confirm') {
      await confirmBooking(booking._id);
      shopControlBot.answerCallbackQuery(callbackQuery.id, { text: 'Booking confirmed!' });

    } else if (action === 'reject') {
      shopControlBot.editMessageText(formatBookingCard(booking, '🟡 *Awaiting rejection reason…*'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });
      pendingRejections.set(message.chat.id.toString(), bookingId);
      await shopControlBot.sendMessage(message.chat.id, '✍️ Please reply with a reason for rejecting this booking.', {
        reply_markup: { force_reply: true },
      });
      shopControlBot.answerCallbackQuery(callbackQuery.id);
    }
  } catch (err) {
    console.error('Error handling shop-control callback:', err);
    shopControlBot.answerCallbackQuery(callbackQuery.id, { text: 'Something went wrong.' }).catch(() => {});
  }
});

shopControlBot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id.toString();
    if (!msg.reply_to_message || !pendingRejections.has(chatId)) return;

    const bookingId = pendingRejections.get(chatId);
    pendingRejections.delete(chatId);
    await rejectBooking(bookingId, msg.text);
    await shopControlBot.sendMessage(chatId, '✅ Rejection reason sent to the client.');
  } catch (err) {
    console.error('Error handling shop-control rejection reason message:', err);
  }
});

export default shopControlBot;
