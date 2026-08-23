// Dedicated bot for shop owners: they use it to log into the admin panel
// (no passwords — Telegram identity is the credential, see routes/adminAuth.js)
// and to receive/confirm/reject their own shop's new bookings. Deliberately
// a separate bot/token from config/telegramBot.js so a customer's chat with
// the booking bot never mixes with an owner's shop-control chat.
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config();
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { registerCardEditor } from './notificationBridge.js';
import { confirmBooking, rejectBooking } from '../services/bookingActions.js';
import { DIVIDER, formatBookingCard } from '../utils/telegramFormat.js';
import { notifyUser as notifyCustomerBotUser } from './telegramBot.js';

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

// Platform-operator-only commands (/gencode, /unclaimed, /resetowner) below
// are gated to this one chat — the same chat that already receives
// unclaimed-shop alerts (see notifyShopOwnerOfNewBooking). Anyone else
// sending these commands is silently ignored, same as if the command didn't
// exist, rather than revealing that an operator-only command exists at all.
const isOperator = (msg) => String(msg.from.id) === String(process.env.TELEGRAM_ADMIN_CHAT_ID);

// Shared by /gencode and /resetowner — finds shop(s) by _id or a
// case-insensitive name match, so the operator never has to open Mongo or
// run a script by hand to look one up.
async function findShopsByQuery(query) {
  if (/^[0-9a-fA-F]{24}$/.test(query)) {
    const shop = await ServicesModel.findById(query);
    return shop ? [shop] : [];
  }
  return ServicesModel.find({ 'name.en': { $regex: query, $options: 'i' } });
}

shopControlBot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name');
    if (shops.length > 0) {
      const names = shops.map((s) => `• ${s.name?.en || s.name?.ru || 'your shop'}`).join('\n');
      return shopControlBot.sendMessage(
        chatId,
        `👋 *Welcome back*\n\nManaging:\n${names}\n\nOpen your dashboard below${shops.length > 1 ? ' and pick a shop' : ''}:`,
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
    // Atomic claim: the update's filter re-checks ownerClaimCode, and the
    // update clears it in the same operation — so if two people race on the
    // same code, only the first one to actually execute in Mongo wins; the
    // second's filter no longer matches (code's already unset) and gets
    // back null, same as an invalid code. A plain findOne-then-save here
    // would have let both requests slip through.
    const shop = await ServicesModel.findOneAndUpdate(
      { ownerClaimCode: code },
      { $set: { ownerTelegramId: msg.from.id }, $unset: { ownerClaimCode: '' } },
      { new: true }
    );
    if (!shop) {
      return shopControlBot.sendMessage(chatId, '❌ Invalid or already-used claim code.');
    }

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

shopControlBot.onText(/^\/myshops$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name');
    if (shops.length === 0) {
      return shopControlBot.sendMessage(chatId, "You're not managing any shops yet. Send `/claim YOUR_CODE` to link one.", { parse_mode: 'Markdown' });
    }
    const lines = shops.map((s) => `• *${s.name?.en || s.name?.ru}*\n  \`/unclaim ${s._id}\` to remove yourself`);
    shopControlBot.sendMessage(chatId, `🏪 *Your shops:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('shopControlBot /myshops error:', err);
  }
});

shopControlBot.onText(/\/unclaim (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const shopId = match[1].trim();
  try {
    // Scoped to ownerTelegramId in the filter itself, so this can only ever
    // remove *your own* ownership, never someone else's shop.
    const shop = await ServicesModel.findOneAndUpdate(
      { _id: shopId, ownerTelegramId: msg.from.id },
      { $set: { ownerTelegramId: null } },
      { new: false }
    );
    if (!shop) {
      return shopControlBot.sendMessage(chatId, "❌ That doesn't look like one of your shops.");
    }
    shopControlBot.sendMessage(
      chatId,
      `✅ You're no longer managing *${shop.name?.en || shop.name?.ru}*. A new claim code is needed for anyone (including you) to link it again.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('shopControlBot /unclaim error:', err);
    shopControlBot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// New-booking notifications now route to the specific shop's owner instead
// of one global admin chat, so each shop only ever sees its own requests.
export const notifyShopOwnerOfNewBooking = async (booking) => {
  const shop = await ServicesModel.findById(booking.shopId).select('ownerTelegramId name');
  if (!shop?.ownerTelegramId) {
    // Nobody would otherwise ever find out this booking exists — fall back
    // to alerting the platform operator (still reachable via the customer
    // bot, since that's the one they originally interacted with) so an
    // unclaimed shop's bookings don't just silently pile up unseen.
    console.warn(`Shop ${booking.shopId} has no linked owner — booking ${booking._id} was not posted to Telegram.`);
    const operatorChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (operatorChatId) {
      await notifyCustomerBotUser(
        operatorChatId,
        `⚠️ *Unclaimed shop got a booking*\n${DIVIDER}\n*Shop:* ${shop?.name?.en || booking.shopName}\n*Client:* ${booking.userName}\nThis shop's owner hasn't linked their Telegram account yet — run \`generateClaimCode.js\` and send them a claim code.`
      );
    }
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
      // Persisted on the booking itself (not an in-memory Map) so a server
      // restart between "tapped Reject" and "typed a reason" doesn't strand
      // this booking awaiting a reply that can never arrive.
      booking.awaitingRejectionReason = true;
      await booking.save();
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
    if (!msg.reply_to_message) return;

    const booking = await Booking.findOne({
      notificationChatId: msg.chat.id,
      awaitingRejectionReason: true,
    }).sort({ updatedAt: -1 });
    if (!booking) return;

    booking.awaitingRejectionReason = false;
    await booking.save();
    await rejectBooking(booking._id, msg.text);
    await shopControlBot.sendMessage(msg.chat.id, '✅ Rejection reason sent to the client.');
  } catch (err) {
    console.error('Error handling shop-control rejection reason message:', err);
  }
});

export default shopControlBot;
