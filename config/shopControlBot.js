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
import StaffShift from '../models/staffShift.js';
import CashRegister from '../models/cashRegister.js';
import { registerCardEditor } from './notificationBridge.js';
import { confirmBooking, rejectBooking } from '../services/bookingActions.js';
import { calculateStaffPayroll } from '../services/staffPayrollService.js';
import { getCurrentRegisterStatus } from '../services/cashRegisterService.js';
import { getShopQueue } from '../services/waitlistService.js';
import { toDateKey, dateKeyToRange } from '../utils/dateKey.js';
import { DIVIDER, formatBookingCard, formatShopOwnerBookingCardHTML, escapeHtml } from '../utils/telegramFormat.js';
import { notifyUser as notifyCustomerBotUser } from './telegramBot.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';
import { escapeMarkdown } from '../utils/escapeMarkdown.js';
import { captureError } from './errorTracking.js';

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

export const stopShopControlBot = async () => {
  if (pollingStarted && shopControlBot) {
    try {
      await shopControlBot.stopPolling();
      pollingStarted = false;
      console.log('🛑 Shop-control bot polling stopped.');
    } catch (err) {
      console.error('Error stopping shop-control bot polling:', err.message);
    }
  }
};

shopControlBot.on('polling_error', (err) => {
  console.error('❌ Shop-control bot polling error:', err.message);
  captureError(err, { source: 'shopControlBot.polling_error' });
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
      const names = shops.map((s) => `• ${escapeMarkdown(s.name?.[lang] || s.name?.en || t(lang, 'owner.yourShopFallback'))}`).join('\n');
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
      t(lang, 'owner.shopLinked', { shopName: escapeMarkdown(shop.name?.[lang] || shop.name?.en || t(lang, 'owner.yourShopFallback')) }),
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
    const lines = shops.map((s) => t(lang, 'owner.unclaimLine', { shopName: escapeMarkdown(s.name?.[lang] || s.name?.en), shopId: s._id }));
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
      t(lang, 'owner.shopUnclaimed', { shopName: escapeMarkdown(shop.name?.[lang] || shop.name?.en) }),
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
    const lines = shops.map((s) => `• ${escapeMarkdown(s.name?.[lang] || s.name?.en)}`).join('\n');
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
      const lines = shops.map((s) => `• ${escapeMarkdown(s.name?.en)} — \`/gencode ${s._id}\``).join('\n');
      return shopControlBot.sendMessage(chatId, t(lang, 'owner.multipleShopsMatch', { query, lines }), { parse_mode: 'Markdown' });
    }

    const shop = shops[0];
    if (shop.ownerTelegramId) {
      return shopControlBot.sendMessage(
        chatId,
        t(lang, 'owner.alreadyClaimed', { shopName: escapeMarkdown(shop.name?.en), ownerTelegramId: shop.ownerTelegramId, shopId: shop._id }),
        { parse_mode: 'Markdown' }
      );
    }

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    shop.ownerClaimCode = code;
    await shop.save();
    console.log(`🔑 Claim code generated for "${shop.name?.en}" by operator`);

    shopControlBot.sendMessage(
      chatId,
      t(lang, 'owner.claimCodeGenerated', { shopName: escapeMarkdown(shop.name?.en), code, botUsername: (await shopControlBot.getMe()).username }),
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
      const lines = shops.map((s) => `• ${escapeMarkdown(s.name?.en)} — \`/resetowner ${s._id}\``).join('\n');
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
        shopName: escapeMarkdown(shop.name?.en),
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
        `⚠️ *Unclaimed shop got a booking*\n${DIVIDER}\n*Shop:* ${escapeMarkdown(shop?.name?.en || booking.shopName)}\n*Client:* ${escapeMarkdown(booking.userName)}\nThis shop's owner hasn't linked their Telegram account yet — run \`generateClaimCode.js\` and send them a claim code.`
      );
    }
    return;
  }

  const cardHtml = formatShopOwnerBookingCardHTML(booking, null, shop);
  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: t(booking.ownerLanguage, 'owner.confirmButton'), callback_data: `confirm_${booking._id}`, style: 'success' },
          { text: t(booking.ownerLanguage, 'owner.rejectButton'), callback_data: `reject_${booking._id}`, style: 'danger' },
        ],
        [
          { text: t(booking.ownerLanguage, 'owner.openDashboardButton'), web_app: { url: `${adminPanelUrl}?shop=${booking.shopId}` }, style: 'primary' },
        ],
      ],
    },
  };
  const sent = await shopControlBot.sendMessage(shop.ownerTelegramId, cardHtml, options);

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
  const shop = await ServicesModel.findById(booking.shopId).select('address');
  await shopControlBot.editMessageText(formatShopOwnerBookingCardHTML(booking, statusLine, shop), {
    chat_id: booking.notificationChatId,
    message_id: booking.notificationMessageId,
    parse_mode: 'HTML',
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
      const prompt = await shopControlBot.sendMessage(message.chat.id, t(lang, 'owner.pleaseReplyReason'), {
        reply_markup: { force_reply: true },
      });
      booking.awaitingRejectionReason = true;
      booking.awaitingReasonPromptMessageId = prompt.message_id;
      await booking.save();
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

    // Matched to the exact "please reply with a reason" prompt the owner
    // hit Reply on — not just "whichever booking most recently asked",
    // which misattributed the reason (and the whole rejection) to the wrong
    // booking whenever two were awaiting a reason at once.
    const booking = await Booking.findOne({
      notificationChatId: msg.chat.id,
      awaitingRejectionReason: true,
      awaitingReasonPromptMessageId: msg.reply_to_message.message_id,
    });
    if (!booking) return;

    booking.awaitingRejectionReason = false;
    booking.awaitingReasonPromptMessageId = null;
    await booking.save();
    await rejectBooking(booking._id, msg.text);
    await shopControlBot.sendMessage(msg.chat.id, t(booking.ownerLanguage, 'owner.reasonSentToClient'));
  } catch (err) {
    console.error('Error handling shop-control rejection reason message:', err);
  }
});

// ==========================================
// SmartChair OS Owner Commands (/shifts, /payroll, /zreport, /queue)
// ==========================================

shopControlBot.onText(/\/shifts/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name staff');
    if (shops.length === 0) return;

    const today = toDateKey(new Date());
    for (const shop of shops) {
      const shifts = await StaffShift.find({ shopId: shop._id, date: today });
      const staffMap = new Map((shop.staff || []).map((s) => [String(s._id), s.name]));
      const shopName = escapeHtml(shop.name?.uz || shop.name?.en || 'Salon');

      let text = `📅 <b>Bugungi Smenalar — ${shopName} (${today})</b>\n\n`;
      if (shifts.length === 0) {
        text += '<i>Bugun uchun rejalashtirilgan smenalar yo‘q.</i>';
      } else {
        for (const sh of shifts) {
          const name = escapeHtml(staffMap.get(String(sh.staffId)) || 'Usta');
          const icon = sh.status === 'active' ? '🟢' : sh.status === 'completed' ? '✅' : sh.status === 'absent' ? '🔴' : '🟡';
          text += `${icon} <b>${name}</b> — ${sh.status.toUpperCase()}\n`;
        }
      }
      await shopControlBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('shopControlBot /shifts error:', err);
  }
});

shopControlBot.onText(/\/payroll/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('_id');
    if (shops.length === 0) return;

    const todayKey = toDateKey(new Date());
    const { start, end } = dateKeyToRange(todayKey);

    for (const shop of shops) {
      const report = await calculateStaffPayroll(shop._id, start, end);
      let text = `💵 <b>Bugungi Daromad va Ulushlar — ${escapeHtml(report.shopName)}</b>\n`;
      text += `📅 Sana: <b>${todayKey}</b>\n\n`;
      text += `💰 Umumiy tushum: <b>${report.totalGrossRevenue.toLocaleString()} UZS</b>\n`;
      text += `👨‍🔧 Ustalar ulushi: <b>${report.totalStaffPayout.toLocaleString()} UZS</b>\n`;
      text += `🏢 Salon foydasi: <b>${report.totalShopRetained.toLocaleString()} UZS</b>\n\n`;

      if (report.staffBreakdown.length > 0) {
        text += `<b>Ustalar kesimida:</b>\n`;
        for (const s of report.staffBreakdown) {
          if (s.grossRevenue === 0) continue;
          text += `• <b>${escapeHtml(s.name)}</b>: ${s.grossRevenue.toLocaleString()} UZS (Ulush: ${s.staffPayout.toLocaleString()} UZS / ${s.commissionRate}%)\n`;
        }
      }
      await shopControlBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('shopControlBot /payroll error:', err);
  }
});

shopControlBot.onText(/\/zreport/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name');
    if (shops.length === 0) return;

    for (const shop of shops) {
      const shopName = escapeHtml(shop.name?.uz || shop.name?.en || 'Salon');
      const current = await getCurrentRegisterStatus(shop._id);

      if (current) {
        const { register, summary } = current;
        const text =
          `🧾 <b>Joriy Kassa Hisoboti (Ochiq Smena) — ${shopName}</b>\n\n` +
          `💵 Boshlang‘ich naqd: <b>${register.openingCashBalance.toLocaleString()} UZS</b>\n` +
          `📈 Jami kirim: <b>${summary.totalIncome.toLocaleString()} UZS</b>\n` +
          `📉 Chiqimlar: <b>${summary.totalExpense.toLocaleString()} UZS</b>\n` +
          `🏦 Kassadagi kutilayotgan naqd: <b>${summary.expectedCashBalance.toLocaleString()} UZS</b>\n\n` +
          `<b>To‘lov turlari:</b>\n` +
          `• Naqd: ${summary.breakdownByMethod.cash.toLocaleString()} UZS\n` +
          `• Click: ${summary.breakdownByMethod.click.toLocaleString()} UZS\n` +
          `• Payme: ${summary.breakdownByMethod.payme.toLocaleString()} UZS\n` +
          `• Terminal: ${summary.breakdownByMethod.terminal_uzcard_humo.toLocaleString()} UZS`;
        await shopControlBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } else {
        const latestClosed = await CashRegister.findOne({ shopId: shop._id, status: 'closed' }).sort({ closedAt: -1 });
        if (!latestClosed) {
          await shopControlBot.sendMessage(chatId, `🧾 <b>${shopName}</b>: Hozircha kassa smenasi ochilmagan.`, { parse_mode: 'HTML' });
        } else {
          const text =
            `🧾 <b>Oxirgi Z-Hisobot (Yopilgan) — ${shopName}</b>\n\n` +
            `📈 Jami kirim: <b>${latestClosed.totalIncome.toLocaleString()} UZS</b>\n` +
            `📉 Chiqimlar: <b>${latestClosed.totalExpense.toLocaleString()} UZS</b>\n` +
            `🏦 Kutilgan naqd: <b>${latestClosed.expectedCashBalance.toLocaleString()} UZS</b>\n` +
            `💵 Haqiqiy naqd: <b>${(latestClosed.closingCashBalance || 0).toLocaleString()} UZS</b>\n` +
            `⚖️ Farq: <b>${latestClosed.cashDiscrepancy.toLocaleString()} UZS</b>`;
          await shopControlBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        }
      }
    }
  } catch (err) {
    console.error('shopControlBot /zreport error:', err);
  }
});

shopControlBot.onText(/\/queue/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const shops = await ServicesModel.find({ ownerTelegramId: msg.from.id }).select('name');
    if (shops.length === 0) return;

    for (const shop of shops) {
      const queue = await getShopQueue(shop._id);
      const shopName = escapeHtml(shop.name?.uz || shop.name?.en || 'Salon');
      let text = `🪑 <b>Jonli Navbat (Walk-In) — ${shopName}</b>\n\n`;
      if (queue.length === 0) {
        text += '<i>Hozirda navbatda kutayotgan mijozlar yo‘q.</i>';
      } else {
        for (const entry of queue) {
          const icon = entry.status === 'called' ? '🔔' : entry.status === 'in_chair' ? '✂️' : '⏳';
          text += `${icon} <b>#${entry.queueNumber} ${escapeHtml(entry.customerName)}</b> (${escapeHtml(entry.serviceName || 'Xizmat')}) — <i>${entry.status}</i>\n`;
        }
      }
      await shopControlBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('shopControlBot /queue error:', err);
  }
});

export default shopControlBot;
