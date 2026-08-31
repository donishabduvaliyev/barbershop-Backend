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
import OwnerPreference from '../models/ownerPreference.js';
import { registerCardEditor } from './notificationBridge.js';
import { confirmBooking, rejectBooking } from '../services/bookingActions.js';
import { DIVIDER, formatBookingCard } from '../utils/telegramFormat.js';
import { notifyUser as notifyCustomerBotUser } from './telegramBot.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';

// Looked up fresh per command reply so a /language change takes effect
// immediately — unlike a booking card's snapshotted ownerLanguage, there's
// no in-flight message to keep consistent here.
async function getOwnerLanguage(telegramId) {
  const pref = await OwnerPreference.findOne({ telegramId }).select('language');
  return normalizeLanguage(pref?.language);
}

const languageKeyboard = {
  inline_keyboard: [[
    { text: "🇺🇿 O'zbekcha", callback_data: 'setlang_uz' },
    { text: '🇷🇺 Русский', callback_data: 'setlang_ru' },
    { text: '🇬🇧 English', callback_data: 'setlang_en' },
  ]],
};

const token = process.env.SHOP_CONTROL_BOT_TOKEN;
const adminPanelUrl = process.env.ADMIN_PANEL_URL || 'http://localhost:5173';
const shopControlBot = new TelegramBot(token, { polling: false });
let pollingStarted = false;

export const startShopControlBot = () => {
  if (pollingStarted) return;
  if (!token) {
    console.warn('⚠️ SHOP_CONTROL_BOT_TOKEN not set — shop-control bot disabled.');
    return;
  }
  pollingStarted = true;
  // See config/telegramBot.js's startBot for why this is logged explicitly
  // rather than just called — a host's log window otherwise can't tell
  // "actually polling" apart from "silently failed to start".
  shopControlBot.startPolling()
    .then(() => console.log('✅ Shop-control bot polling started.'))
    .catch((err) => console.error('❌ Shop-control bot failed to start polling:', err.message));
};

shopControlBot.on('polling_error', (err) => {
  console.error('❌ Shop-control bot polling error:', err.message);
});

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
    const lang = await getOwnerLanguage(msg.from.id);
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name');
    if (shops.length > 0) {
      const names = shops.map((s) => `• ${s.name?.[lang] || s.name?.en || t(lang, 'owner.yourShopFallback')}`).join('\n');
      return shopControlBot.sendMessage(
        chatId,
        t(lang, 'owner.welcomeBackTitle', { names, multiShopSuffix: shops.length > 1 ? t(lang, 'owner.multiShopSuffix') : '' }),
        { parse_mode: 'Markdown', reply_markup: dashboardKeyboard }
      );
    }
    shopControlBot.sendMessage(chatId, t(lang, 'owner.shopControlWelcome'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('shopControlBot /start error:', err);
  }
});

// Reachable any time. Updates OwnerPreference, which every other reply in
// this file looks up fresh.
shopControlBot.onText(/\/language/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = await getOwnerLanguage(msg.from.id);
  shopControlBot.sendMessage(chatId, t(lang, 'owner.languagePrompt'), { reply_markup: languageKeyboard });
});

shopControlBot.onText(/\/claim (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();
  const lang = await getOwnerLanguage(msg.from.id);
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
      console.log(`⏭️ Claim attempt failed (invalid/used code) — Telegram user ${msg.from.id}`);
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.invalidClaimCode'));
    }
    console.log(`🔗 Shop "${shop.name?.en}" claimed by Telegram user ${msg.from.id}`);

    shopControlBot.sendMessage(
      chatId,
      t(lang, 'owner.shopLinked', { shopName: shop.name?.[lang] || shop.name?.en || t(lang, 'owner.yourShopFallback') }),
      { parse_mode: 'Markdown', reply_markup: dashboardKeyboard }
    );
  } catch (err) {
    console.error('shopControlBot /claim error:', err);
    shopControlBot.sendMessage(chatId, t(lang, 'owner.claimError'));
  }
});

shopControlBot.onText(/^\/myshops$/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = await getOwnerLanguage(msg.from.id);
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name');
    if (shops.length === 0) {
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.noShopsYet'), { parse_mode: 'Markdown' });
    }
    const lines = shops.map((s) => t(lang, 'owner.unclaimLine', { shopName: s.name?.[lang] || s.name?.en, shopId: s._id }));
    shopControlBot.sendMessage(chatId, t(lang, 'owner.yourShopsTitle', { lines: lines.join('\n\n') }), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('shopControlBot /myshops error:', err);
  }
});

shopControlBot.onText(/\/unclaim (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const shopId = match[1].trim();
  const lang = await getOwnerLanguage(msg.from.id);
  try {
    // Scoped to ownerTelegramId in the filter itself, so this can only ever
    // remove *your own* ownership, never someone else's shop.
    const shop = await ServicesModel.findOneAndUpdate(
      { _id: shopId, ownerTelegramId: msg.from.id },
      { $set: { ownerTelegramId: null } },
      { new: false }
    );
    if (!shop) {
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.notYourShop'));
    }
    console.log(`🔓 Shop "${shop.name?.en}" unclaimed by Telegram user ${msg.from.id}`);
    shopControlBot.sendMessage(
      chatId,
      t(lang, 'owner.shopUnclaimed', { shopName: shop.name?.[lang] || shop.name?.en }),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('shopControlBot /unclaim error:', err);
    shopControlBot.sendMessage(chatId, t(lang, 'owner.genericTryAgain'));
  }
});

// --- Operator-only shop-onboarding commands (see isOperator above) ---

shopControlBot.onText(/^\/unclaimed$/, async (msg) => {
  if (!isOperator(msg)) return;
  const chatId = msg.chat.id;
  const lang = await getOwnerLanguage(msg.from.id);
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: null }).select('name');
    if (shops.length === 0) {
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.everyShopLinked'));
    }
    const lines = shops.map((s) => `• ${s.name?.[lang] || s.name?.en}`).join('\n');
    shopControlBot.sendMessage(chatId, t(lang, 'owner.unclaimedShopsTitle', { lines }), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('shopControlBot /unclaimed error:', err);
  }
});

shopControlBot.onText(/\/gencode (.+)/, async (msg, match) => {
  if (!isOperator(msg)) return;
  const chatId = msg.chat.id;
  const query = match[1].trim();
  const lang = await getOwnerLanguage(msg.from.id);
  try {
    const shops = await findShopsByQuery(query);
    if (shops.length === 0) {
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.noShopMatches', { query }));
    }
    if (shops.length > 1) {
      const lines = shops.map((s) => `• ${s.name?.en} — \`/gencode ${s._id}\``).join('\n');
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.multipleShopsMatch', { query, lines }), { parse_mode: 'Markdown' });
    }

    const shop = shops[0];
    if (shop.ownerTelegramId) {
      return shopControlBot.sendMessage(
        chatId,
        t(lang, 'owner.alreadyClaimed', { shopName: shop.name?.en, ownerTelegramId: shop.ownerTelegramId, shopId: shop._id }),
        { parse_mode: 'Markdown' }
      );
    }

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    shop.ownerClaimCode = code;
    await shop.save();
    console.log(`🔑 Claim code generated for "${shop.name?.en}" by operator`);

    shopControlBot.sendMessage(
      chatId,
      t(lang, 'owner.claimCodeGenerated', { shopName: shop.name?.en, code, botUsername: (await shopControlBot.getMe()).username }),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('shopControlBot /gencode error:', err);
    shopControlBot.sendMessage(chatId, t(lang, 'owner.gencodeError'));
  }
});

shopControlBot.onText(/\/resetowner (.+)/, async (msg, match) => {
  if (!isOperator(msg)) return;
  const chatId = msg.chat.id;
  const query = match[1].trim();
  const lang = await getOwnerLanguage(msg.from.id);
  try {
    const shops = await findShopsByQuery(query);
    if (shops.length === 0) {
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.noShopMatches', { query }));
    }
    if (shops.length > 1) {
      const lines = shops.map((s) => `• ${s.name?.en} — \`/resetowner ${s._id}\``).join('\n');
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.multipleShopsMatch', { query, lines }), { parse_mode: 'Markdown' });
    }

    const shop = shops[0];
    const previousOwner = shop.ownerTelegramId;
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    shop.ownerTelegramId = null;
    shop.ownerClaimCode = code;
    await shop.save();
    console.log(`♻️ Ownership reset for "${shop.name?.en}" by operator${previousOwner ? ` (was Telegram user ${previousOwner})` : ''}`);

    shopControlBot.sendMessage(
      chatId,
      t(lang, 'owner.ownershipReset', {
        shopName: shop.name?.en,
        code,
        previousOwnerSuffix: previousOwner ? t(lang, 'owner.previousOwnerSuffix', { previousOwner }) : '',
      }),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('shopControlBot /resetowner error:', err);
    shopControlBot.sendMessage(chatId, t(lang, 'owner.resetOwnerError'));
  }
});

// New-booking notifications now route to the specific shop's owner instead
// of one global admin chat, so each shop only ever sees its own requests.
export const notifyShopOwnerOfNewBooking = async (booking) => {
  const shop = await ServicesModel.findById(booking.shopId).select('ownerTelegramId name');
  if (shop?.ownerTelegramId) {
    // The only place ownerLanguage ever gets written — snapshotted once so
    // a later /language change never rewrites this card's language mid-flow.
    const pref = await OwnerPreference.findOne({ telegramId: shop.ownerTelegramId }).select('language');
    booking.ownerLanguage = normalizeLanguage(pref?.language);
  }
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
        [
          { text: t(booking.ownerLanguage, 'owner.confirmButton'), callback_data: `confirm_${booking._id}` },
          { text: t(booking.ownerLanguage, 'owner.rejectButton'), callback_data: `reject_${booking._id}` },
        ],
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

    if (action === 'setlang') {
      const newLang = normalizeLanguage(bookingId); // second segment is the language code here
      await OwnerPreference.findOneAndUpdate(
        { telegramId: callbackQuery.from.id },
        { $set: { language: newLang } },
        { upsert: true }
      );
      shopControlBot.answerCallbackQuery(callbackQuery.id);
      return shopControlBot.editMessageText(t(newLang, 'owner.languageSet'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      const lang = await getOwnerLanguage(callbackQuery.from.id);
      shopControlBot.answerCallbackQuery(callbackQuery.id);
      return shopControlBot.editMessageText(t(lang, 'owner.bookingNotFound'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }
    const lang = normalizeLanguage(booking.ownerLanguage);

    if (action === 'confirm') {
      await confirmBooking(booking._id);
      shopControlBot.answerCallbackQuery(callbackQuery.id, { text: t(lang, 'owner.bookingConfirmedToast') });

    } else if (action === 'reject') {
      shopControlBot.editMessageText(formatBookingCard(booking, t(lang, 'owner.awaitingReasonLine')), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });
      // Persisted on the booking itself (not an in-memory Map) so a server
      // restart between "tapped Reject" and "typed a reason" doesn't strand
      // this booking awaiting a reply that can never arrive.
      booking.awaitingRejectionReason = true;
      await booking.save();
      await shopControlBot.sendMessage(message.chat.id, t(lang, 'owner.pleaseReplyReason'), {
        reply_markup: { force_reply: true },
      });
      shopControlBot.answerCallbackQuery(callbackQuery.id);
    }
  } catch (err) {
    console.error('Error handling shop-control callback:', err);
    shopControlBot.answerCallbackQuery(callbackQuery.id, { text: t('uz', 'owner.genericErrorToast') }).catch(() => {});
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
    await shopControlBot.sendMessage(msg.chat.id, t(booking.ownerLanguage, 'owner.reasonSentToClient'));
  } catch (err) {
    console.error('Error handling shop-control rejection reason message:', err);
  }
});

export default shopControlBot;
