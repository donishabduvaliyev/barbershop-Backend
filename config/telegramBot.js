import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();
import User from '../models/userdata.js';
import Booking from '../models/bookingHistory.js';
import Review from '../models/review.js';
import ServicesModel from '../models/shopData.js';
import MobileAuthSession from '../models/mobileAuthSession.js';
import { signMobileCustomerToken } from '../middleware/telegramAuth.js';
import { emitToAuthSession, emitToUser } from './socket.js';
import { DIVIDER, formatDateTime, formatCustomerConfirmedCardHTML, escapeHtml } from '../utils/telegramFormat.js';
import { t, normalizeLanguage, LANGUAGE_NAMES } from '../utils/botMessages.js';
import { escapeMarkdown } from '../utils/escapeMarkdown.js';
import { captureError } from './errorTracking.js';
import {
  calculateShopSlotsForDate,
  buildBookingWidgetHtml,
  buildTicketWidgetHtml,
  buildCompactFallbackKeyboard,
} from '../services/telegramWidgetService.js';
import { createBooking } from '../services/createBooking.js';
import { cancelBooking } from '../services/bookingActions.js';
import WaitlistEntry from '../models/waitlistEntry.js';
import { toDateKey } from '../utils/dateKey.js';

// A customer's chosen (or web-app-inferred) language, looked up fresh per
// message so a /language change takes effect immediately — unlike a
// booking's snapshotted userLanguage, there's no "in-flight card" to keep
// consistent here.
async function getUserLanguage(telegramId) {
  const user = await User.findOne({ telegramId: String(telegramId) }).select('language');
  return normalizeLanguage(user?.language);
}

const languageKeyboard = {
  inline_keyboard: [[
    { text: "🇺🇿 O'zbekcha", callback_data: 'setlang_uz' },
    { text: '🇷🇺 Русский', callback_data: 'setlang_ru' },
    { text: '🇬🇧 English', callback_data: 'setlang_en' },
  ]],
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: false });
let pollingStarted = false;

// Direct REST call to Telegram Bot API for methods like sendWidget / answerWidgetQuery
export async function callTelegramApi(method, payload) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || token;
  if (!botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Hook processUpdate to catch Bot API 10.4 widget_query updates and emit them
if (bot && typeof bot.processUpdate === 'function') {
  const origProcessUpdate = bot.processUpdate.bind(bot);
  bot.processUpdate = function(update) {
    if (update && update.widget_query) {
      this.emit('widget_query', update.widget_query);
    }
    return origProcessUpdate(update);
  };
}

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

export const stopBot = async () => {
  if (pollingStarted && bot) {
    try {
      await bot.stopPolling();
      pollingStarted = false;
      console.log('🛑 Customer bot polling stopped.');
    } catch (err) {
      console.error('Error stopping customer bot polling:', err.message);
    }
  }
};

// Without an explicit listener, a 409 (another instance already polling
// this same token — see DISABLE_TELEGRAM_POLLING in server.js) or any other
// polling failure happens silently on some hosts instead of showing up in
// the log window, which looks identical to "nothing is happening" from the
// customer's side.
bot.on('polling_error', (err) => {
  console.error('❌ Customer bot polling error:', err.message);
  captureError(err, { source: 'customerBot.polling_error' });
});

export const webAppUrl = 'https://barbershop-telegram-bot.netlify.app';

// Short name of this bot's Mini App, attached once via @BotFather ->
// /newapp — required for the t.me/<bot>/<shortname>?startapp=... direct
// links used by the per-shop QR codes (routes/superAdmin.js).
export const miniAppShortName = process.env.TELEGRAM_MINI_APP_SHORT_NAME || '';

// Cached after the first call — bot.getMe() doesn't change at runtime, and
// this is now called per QR-link request rather than once like the shop
// -control bot's claim-code message (config/shopControlBot.js:232).
let cachedUsername = null;
export async function getBotUsername() {
  if (!cachedUsername) {
    cachedUsername = (await bot.getMe()).username;
  }
  return cachedUsername;
}

// start the bot — a per-shop QR code encodes a deep link
// (t.me/<bot>?start=shop_<id>, built in routes/superAdmin.js's /qr-link)
// so /start can arrive with a payload after it. Deliberately requiring an
// explicit /start (rather than opening the mini app directly) guarantees
// Telegram will let this bot message the customer later — the booking
// confirm/reject notifications (services/bookingActions.js) depend on that.
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const lang = await getUserLanguage(msg.from.id);

    // 1. Mobile App Telegram Deep-Link Auth (`/start login_<32-hex-token>`)
    const loginMatch = match?.[1]?.match(/^login_([a-f0-9]{32})$/);
    if (loginMatch) {
        const sessionToken = loginMatch[1];
        try {
            const session = await MobileAuthSession.findOne({ sessionToken, status: 'pending' });
            if (!session) {
                return bot.sendMessage(chatId, t(lang, 'customer.mobileLoginExpired'), { parse_mode: 'Markdown' });
            }

            const telegramIdStr = String(msg.from.id);
            const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
            const username = msg.from.username || '';

            let avatarUrl = '';
            try {
                const photos = await bot.getUserProfilePhotos(msg.from.id, { limit: 1 });
                if (photos && photos.total_count > 0) {
                    const fileId = photos.photos[0][0].file_id;
                    avatarUrl = await bot.getFileLink(fileId);
                }
            } catch {
                // Non-fatal if profile photo fetch fails
            }

            const updateFields = {
                name: fullName,
                username,
                lastPlatform: 'mobile',
            };
            if (avatarUrl) updateFields.avatar = avatarUrl;

            const user = await User.findOneAndUpdate(
                { telegramId: telegramIdStr },
                { $set: updateFields },
                { new: true, upsert: true }
            );

            session.status = 'authenticated';
            session.telegramId = telegramIdStr;
            await session.save();

            const jwtToken = signMobileCustomerToken({
                telegramId: msg.from.id,
                username: user.username,
                name: user.name,
            });

            // Push real-time login completion to the waiting React Native app
            emitToAuthSession(sessionToken, 'auth:approved', {
                status: 'authenticated',
                token: jwtToken,
                user: {
                    telegramId: user.telegramId,
                    name: user.name,
                    username: user.username,
                    phone: user.phone || '',
                    email: user.email || '',
                    avatar: user.avatar || '',
                    favorites: user.favorites || [],
                    language: user.language || lang,
                },
            });

            if (user.phone) {
                return bot.sendMessage(chatId, t(lang, 'customer.mobileLoginSuccess'), {
                    parse_mode: 'Markdown',
                });
            }

            return bot.sendMessage(chatId, t(lang, 'customer.mobileLoginAskPhone'), {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [[{ text: t(lang, 'customer.sendPhoneButton'), request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            });
        } catch (err) {
            console.error('Error handling mobile Telegram login:', err);
            return bot.sendMessage(chatId, t(lang, 'customer.registrationError'));
        }
    }

    const shopMatch = match?.[1]?.match(/^shop_([a-f0-9]{24})$/);
    if (shopMatch) {
        const shop = await ServicesModel.findById(shopMatch[1]);
        if (shop) {
            return await sendInteractiveBookingWidget(chatId, shop);
        }
        // Shop was deleted/bad id — fall through to the normal welcome
        // flow below rather than leaving the customer with nothing.
    }

    bot.sendMessage(
        chatId,
        t(lang, 'customer.welcome'),
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{
                        text: t(lang, 'customer.sendPhoneButton'),
                        request_contact: true,
                    }],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            },
        }
    );
});

// Reachable any time, not just on first contact — inline picker updates
// User.language, which every other message in this file looks up fresh.
bot.onText(/\/language/, async (msg) => {
    const chatId = msg.chat.id;
    const lang = await getUserLanguage(msg.from.id);
    bot.sendMessage(chatId, t(lang, 'customer.languagePrompt'), { reply_markup: languageKeyboard });
});
// add contact to db
bot.on('contact', async (msg) => {
    console.log("Received contact information."); // <-- LOG 1
    const chatId = msg.chat.id;
    const contact = msg.contact;

    if (msg.from.id !== contact.user_id) {
        const lang = await getUserLanguage(msg.from.id);
        return bot.sendMessage(chatId, t(lang, 'customer.shareOwnPhone'), { parse_mode: 'Markdown' });
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
        const savedUser = await User.findOneAndUpdate(
            { telegramId: userData.telegramId },
            { $set: userData },
            { new: true, upsert: true }
        );

        // Emit live update so both Web and Mobile apps immediately receive the user's phone & avatar
        emitToUser(userData.telegramId, 'user:updated', {
            telegramId: savedUser.telegramId,
            name: savedUser.name,
            username: savedUser.username,
            phone: savedUser.phone,
            email: savedUser.email,
            avatar: savedUser.avatar,
            favorites: savedUser.favorites || [],
            language: savedUser.language,
        });

        const lang = await getUserLanguage(msg.from.id);
        bot.sendMessage(
            chatId,
            t(lang, 'customer.allSet'),
            {
                parse_mode: 'Markdown',
                reply_markup: {
                   
                    resize_keyboard: true
                }
            }
        );

    } catch (error) {
        // This is the most important log. Let's see the full error.
        console.error("❌ DATABASE ERROR:", error);
        const lang = await getUserLanguage(msg.from.id);
        bot.sendMessage(chatId, t(lang, 'customer.registrationError'));
    }
});

// A booking's userTelegramId can belong to a chat the bot can no longer
// message (user blocked the bot, deleted their account, or — historically,
// before auth was enforced — was never a real chat at all). None of that
// should ever be allowed to crash the bot or block the admin-facing flow.
export const notifyUser = async (chatId, text, extra = {}) => {
  // A walk-in customer created through the admin panel's manual-booking
  // flow (no real Telegram account) is assigned a synthetic NEGATIVE
  // telegramId — real Telegram chat ids are always positive — precisely so
  // they can flow through every booking/notification code path unchanged.
  // This is the one place that needs to know the difference: there's no
  // real chat to message, so skip the API call rather than log a confusing
  // "Failed to message Telegram user -1234" for every one of their bookings.
  if (typeof chatId === 'number' && chatId <= 0) return;
  try {
    const parse_mode = extra.parse_mode || (text.includes('<') && text.includes('>') ? 'HTML' : 'Markdown');
    await bot.sendMessage(chatId, text, { parse_mode, ...extra });
  } catch (err) {
    console.error(`Failed to message Telegram user ${chatId}:`, err.message);
    // Deliberately not forwarding `text` — it's the actual message body,
    // which can carry a customer's name, phone number, or an owner-typed
    // rejection reason. `err.message` (from the Telegram API itself, e.g.
    // "bot was blocked by the user") already says what actually failed
    // without sending that content to a third-party service.
    captureError(err, { source: 'notifyUser', chatId });
  }
};

const buildStarKeyboard = (prefix, bookingId) => ({
  inline_keyboard: [
    [1, 2, 3, 4, 5].map((n) => ({ text: '⭐'.repeat(n), callback_data: `${prefix}_${bookingId}_${n}` })),
  ],
});

// Called by jobs/reminders.js as bookings cross the 24h/3h-before
// thresholds. whenKey is 'whenTomorrow' or 'whenInAFewHours' — a
// translation key, not display text, so it renders in the customer's
// language rather than always English.
export const sendReminder = async (booking, whenKey) => {
  const lang = normalizeLanguage(booking.userLanguage);
  const message = [
    t(lang, 'customer.reminderTitle'),
    DIVIDER,
    t(lang, 'customer.reminderBody', { shopName: escapeMarkdown(booking.shopName), whenLabel: t(lang, `customer.${whenKey}`) }),
    `🗓 ${formatDateTime(booking.requestedTime, lang)}`,
    booking.staffName ? t(lang, 'customer.reminderBarber', { staffName: escapeMarkdown(booking.staffName) }) : null,
  ].filter(Boolean).join('\n');
  await notifyUser(booking.userTelegramId, message);
};

// Called by services/bookingActions.js once a confirmed booking's time has
// passed — kicks off the rating flow via inline star buttons.
export const sendRatingRequest = async (booking) => {
  const lang = normalizeLanguage(booking.userLanguage);
  const message = [
    t(lang, 'customer.ratingTitle'),
    DIVIDER,
    t(lang, 'customer.ratingBody', { shopName: escapeMarkdown(booking.shopName) }),
  ].join('\n');
  await notifyUser(booking.userTelegramId, message, {
    reply_markup: buildStarKeyboard('rate', booking._id),
  });
};

/**
 * Sends or opens Telegram Bot API 10.4 In-Chat Interactive Booking Widget.
 * Falls back automatically to rich inline keyboard buttons for older clients.
 */
export async function sendInteractiveBookingWidget(chatId, shopOrId, options = {}) {
  if (typeof chatId === 'number' && chatId <= 0) return false;
  try {
    const shop = typeof shopOrId === 'string'
      ? await ServicesModel.findById(shopOrId)
      : shopOrId;
    if (!shop) return false;

    const lang = await getUserLanguage(chatId);
    const dateStr = options.dateStr || new Date().toISOString().slice(0, 10);
    const slots = await calculateShopSlotsForDate(shop, dateStr, options.staffId);
    const staffList = shop.staff || [];

    const widgetHtml = buildBookingWidgetHtml({
      shop,
      dateStr,
      slots,
      staffList,
      selectedStaffId: options.staffId || '',
      selectedTime: options.selectedTime || '',
      lang,
    });

    const shopName = shop.name?.[lang] || shop.name?.en || shop.name?.uz || shop.name?.ru || 'SmartChair';

    // Attempt Telegram Bot API 10.4 sendWidget
    const res = await callTelegramApi('sendWidget', {
      chat_id: chatId,
      widget: {
        html: widgetHtml,
        height: 380,
      },
    });

    if (res && res.ok) {
      return res;
    }

    // Fallback: Client does not support sendWidget or API returned error
    const fallbackKeyboard = buildCompactFallbackKeyboard({
      shop,
      dateStr,
      slots,
      lang,
      webAppUrl,
    });

    const fallbackText = [
      `💈 <b>${escapeHtml(shopName)}</b>`,
      DIVIDER,
      t(lang, 'customer.widgetFallbackIntro', { shopName: `<b>${escapeHtml(shopName)}</b>`, date: dateStr }),
    ].join('\n');

    return await bot.sendMessage(chatId, fallbackText, {
      parse_mode: 'HTML',
      reply_markup: fallbackKeyboard,
    });
  } catch (err) {
    console.error('Error in sendInteractiveBookingWidget:', err);
    captureError(err, { source: 'sendInteractiveBookingWidget', chatId });
    return false;
  }
}

/**
 * Sends Telegram Bot API 10.4 In-Chat Interactive Confirmed Ticket Widget.
 * Features live countdown timer, status indicator, and instant cancel/reschedule.
 * Falls back to rich inline card for older clients.
 */
export async function sendInteractiveTicketWidget(chatId, booking) {
  if (!chatId || Number(chatId) <= 0) return;
  try {
    const lang = normalizeLanguage(booking.userLanguage);
    const widgetHtml = buildTicketWidgetHtml({ booking, lang });

    // Attempt Telegram Bot API 10.4 sendWidget with celebratory effect
    const res = await callTelegramApi('sendWidget', {
      chat_id: chatId,
      message_effect_id: '5046509860389126464',
      widget: {
        html: widgetHtml,
        height: 300,
      },
    });

    if (res && res.ok) {
      return res;
    }

    // Fallback: Rich inline luxury card with <blockquote expandable> and colored action buttons
    const shop = await ServicesModel.findById(booking.shopId);
    const fallbackText = formatCustomerConfirmedCardHTML({ booking, shop, lang });

    const fallbackKeyboard = {
      inline_keyboard: [
        [
          { text: `❌ ${t(lang, 'customer.widgetCancel')}`, callback_data: `wticket_cancel_${booking._id}`, style: 'danger' },
          { text: `🚀 ${t(lang, 'customer.openShopButton')}`, web_app: { url: `${webAppUrl}/history` }, style: 'primary' },
        ],
      ],
    };

    return await bot.sendMessage(chatId, fallbackText, {
      parse_mode: 'HTML',
      message_effect_id: '5046509860389126464',
      reply_markup: fallbackKeyboard,
    });
  } catch (err) {
    console.error('Error in sendInteractiveTicketWidget:', err);
    captureError(err, { source: 'sendInteractiveTicketWidget', chatId });
  }
}

// /book command opens the interactive widget directly for the customer's favorite or latest shop
bot.onText(/\/book/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const lang = await getUserLanguage(msg.from.id);
    const user = await User.findOne({ telegramId: String(msg.from.id) }).select('favorites');
    let targetShop = null;

    if (user?.favorites?.length > 0) {
      targetShop = await ServicesModel.findById(user.favorites[0]);
    }
    if (!targetShop) {
      const recentBooking = await Booking.findOne({ userTelegramId: String(msg.from.id) }).sort({ createdAt: -1 });
      if (recentBooking) {
        targetShop = await ServicesModel.findById(recentBooking.shopId);
      }
    }
    if (!targetShop) {
      targetShop = await ServicesModel.findOne({ isOperational: true });
    }

    if (!targetShop) {
      return bot.sendMessage(chatId, t(lang, 'customer.noShopsAvailable'), {
        reply_markup: {
          inline_keyboard: [[{ text: t(lang, 'customer.openAppButton'), web_app: { url: webAppUrl } }]],
        },
      });
    }

    return await sendInteractiveBookingWidget(chatId, targetShop);
  } catch (err) {
    console.error('Error in /book handler:', err);
  }
});

// /mybookings command shows interactive ticket widget for upcoming appointments
bot.onText(/\/mybookings/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const lang = await getUserLanguage(msg.from.id);
    const activeBooking = await Booking.findOne({
      userTelegramId: String(msg.from.id),
      status: { $in: ['pending', 'confirmed'] },
      requestedTime: { $gte: new Date() },
    }).sort({ requestedTime: 1 });

    if (!activeBooking) {
      return bot.sendMessage(chatId, t(lang, 'customer.noActiveBookings'), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `⚡️ ${t(lang, 'customer.bookAppointmentButton')}`, callback_data: 'cmd_book', style: 'success' },
              { text: `🚀 ${t(lang, 'customer.openAppButton')}`, web_app: { url: webAppUrl }, style: 'primary' },
            ],
          ],
        },
      });
    }

    return await sendInteractiveTicketWidget(chatId, activeBooking);
  } catch (err) {
    console.error('Error in /mybookings handler:', err);
  }
});

// customer star-rating flow — the only callback/message handling left on
// this bot. Confirm/reject/rejection-reason handling now lives entirely on
// the shop-control bot (config/shopControlBot.js), since only shop owners
// see those buttons.
bot.on('callback_query', async (callbackQuery) => {
  try {
    const { data, message } = callbackQuery;
    const parts = data.split('_');
    const action = parts[0];

    if (action === 'setlang') {
      const newLang = normalizeLanguage(parts[1]); // second segment is the language code here
      await User.updateOne({ telegramId: String(callbackQuery.from.id) }, { $set: { language: newLang } }, { upsert: true });
      bot.answerCallbackQuery(callbackQuery.id);
      return bot.editMessageText(t(newLang, 'customer.languageSet'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }

    if (data.startsWith('book_shop_')) {
      const targetShopId = data.slice('book_shop_'.length);
      await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      const shop = await ServicesModel.findById(targetShopId);
      if (shop) {
        return await sendInteractiveBookingWidget(message.chat.id, shop);
      }
      return;
    }

    if (action === 'wslot') {
      // Callback format: wslot_<shopId>_<dateStr>_<hour>
      const shopId = parts[1];
      const dateStr = parts[2];
      const hour = parts[3];
      const lang = await getUserLanguage(callbackQuery.from.id);
      const user = await User.findOne({ telegramId: String(callbackQuery.from.id) });

      const reqDate = new Date(dateStr);
      reqDate.setHours(Number(hour), 0, 0, 0);

      try {
        const booking = await createBooking({
          shopId,
          requestedTime: reqDate,
          userTelegramId: String(callbackQuery.from.id),
          userTelegramUsername: callbackQuery.from.username || '',
          userNumber: user?.phone || '',
          userTelegramNumber: user?.phone || '',
          userName: user?.name || `${callbackQuery.from.first_name || ''} ${callbackQuery.from.last_name || ''}`.trim() || 'Client',
          userLanguage: lang,
          source: 'telegram_inline',
        });

        bot.answerCallbackQuery(callbackQuery.id, { text: t(lang, 'customer.widgetBookingSuccess') });
        const shop = await ServicesModel.findById(booking.shopId);
        const cardHtml = formatCustomerConfirmedCardHTML({ booking, shop, lang });
        await bot.editMessageText(cardHtml, {
          chat_id: message.chat.id,
          message_id: message.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: `❌ ${t(lang, 'customer.widgetCancel')}`, callback_data: `wticket_cancel_${booking._id}`, style: 'danger' },
                { text: `🚀 ${t(lang, 'customer.openShopButton')}`, web_app: { url: `${webAppUrl}/history` }, style: 'primary' },
              ],
            ],
          },
        });
        return await sendInteractiveTicketWidget(message.chat.id, booking);
      } catch (err) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: err.message || t(lang, 'customer.genericErrorToast'),
          show_alert: true,
        });
      }
    }

    if (action === 'wticket' && parts[1] === 'cancel') {
      const targetBookingId = parts[2];
      const lang = await getUserLanguage(callbackQuery.from.id);
      try {
        await cancelBooking(targetBookingId, 'Cancelled by customer via inline button');
        bot.answerCallbackQuery(callbackQuery.id, { text: t(lang, 'customer.widgetCancelledSuccess') });
        return bot.editMessageText(`⚫ <b>${t(lang, 'owner.statusCancelled')}</b>`, {
          chat_id: message.chat.id,
          message_id: message.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: `⚡️ ${t(lang, 'customer.bookAppointmentButton')}`, callback_data: 'cmd_book', style: 'success' },
                { text: `🚀 ${t(lang, 'customer.openAppButton')}`, web_app: { url: webAppUrl }, style: 'primary' },
              ],
            ],
          },
        });
      } catch (err) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: err.message || t(lang, 'customer.genericErrorToast'),
          show_alert: true,
        });
      }
    }

    if (action === 'cmd' && parts[1] === 'book') {
      bot.answerCallbackQuery(callbackQuery.id);
      const shop = await ServicesModel.findOne({ isOperational: true });
      if (shop) {
        return await sendInteractiveBookingWidget(message.chat.id, shop);
      }
      return;
    }

    if (action !== 'rate' && action !== 'staffrate') return;

    const bookingId = parts[1];
    const starsRaw = parts[2];
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      const lang = await getUserLanguage(callbackQuery.from.id);
      bot.answerCallbackQuery(callbackQuery.id);
      return bot.editMessageText(t(lang, 'customer.bookingNotFound'), {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }
    const lang = normalizeLanguage(booking.userLanguage);

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

      bot.editMessageText(t(lang, 'customer.ratingThanks', { divider: DIVIDER, stars: '⭐'.repeat(stars) }), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });

      if (booking.staffId && booking.staffName && !existing?.staffRating) {
        await bot.sendMessage(message.chat.id, t(lang, 'customer.staffRatingPrompt', { staffName: escapeMarkdown(booking.staffName) }), {
          parse_mode: 'Markdown',
          reply_markup: buildStarKeyboard('staffrate', booking._id),
        });
      }
      bot.answerCallbackQuery(callbackQuery.id, { text: t(lang, 'customer.ratingToast') });

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

      bot.editMessageText(t(lang, 'customer.staffRatingThanks', { staffName: escapeMarkdown(booking.staffName), stars: '⭐'.repeat(stars) }), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: 'Markdown',
      });
      bot.answerCallbackQuery(callbackQuery.id, { text: t(lang, 'customer.staffRatingToast') });
    }
  } catch (err) {
    console.error('Error handling rating callback:', err);
    bot.answerCallbackQuery(callbackQuery.id, { text: t('uz', 'customer.genericErrorToast') }).catch(() => {});
  }
});

// Handle Bot API 10.4 widget_query updates
bot.on('widget_query', async (query) => {
  try {
    const rawData = query.data;
    const data = typeof rawData === 'string' ? JSON.parse(rawData) : (rawData || {});
    const userId = query.from?.id;
    const lang = await getUserLanguage(userId);
    const chatId = query.message?.chat?.id || userId;

    if (data.action === 'confirm_booking') {
      const user = await User.findOne({ telegramId: String(userId) });
      const [hourStr, minStr] = (data.time || '09:00').split(':');
      const reqDate = new Date(data.date || new Date());
      reqDate.setHours(Number(hourStr), Number(minStr || 0), 0, 0);

      try {
        const booking = await createBooking({
          shopId: data.shopId,
          requestedTime: reqDate,
          staffId: data.staffId || null,
          userTelegramId: String(userId),
          userTelegramUsername: query.from?.username || '',
          userNumber: user?.phone || '',
          userTelegramNumber: user?.phone || '',
          userName: user?.name || `${query.from?.first_name || ''} ${query.from?.last_name || ''}`.trim() || 'Client',
          userLanguage: lang,
          source: 'telegram_widget',
        });

        await callTelegramApi('answerWidgetQuery', {
          widget_query_id: query.id,
          text: t(lang, 'customer.widgetBookingSuccess'),
        });

        return await sendInteractiveTicketWidget(chatId, booking);
      } catch (err) {
        return await callTelegramApi('answerWidgetQuery', {
          widget_query_id: query.id,
          text: err.message || t(lang, 'customer.genericErrorToast'),
          show_alert: true,
        });
      }
    }

    if (data.action === 'change_date' || data.action === 'change_staff') {
      const shop = await ServicesModel.findById(data.shopId);
      if (shop) {
        const slots = await calculateShopSlotsForDate(shop, data.date, data.staffId);
        const newHtml = buildBookingWidgetHtml({
          shop,
          dateStr: data.date,
          slots,
          staffList: shop.staff || [],
          selectedStaffId: data.staffId || '',
          selectedTime: '',
          lang,
        });

        if (query.message?.chat?.id && query.message?.message_id) {
          await callTelegramApi('editMessageWidgetData', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            widget: { html: newHtml, height: 380 },
          });
        }
      }
      return await callTelegramApi('answerWidgetQuery', { widget_query_id: query.id });
    }

    if (data.action === 'cancel_booking') {
      await cancelBooking(data.bookingId, 'Cancelled by customer via interactive widget');
      return await callTelegramApi('answerWidgetQuery', {
        widget_query_id: query.id,
        text: t(lang, 'customer.widgetCancelledSuccess'),
      });
    }

    if (data.action === 'reschedule_booking') {
      const booking = await Booking.findById(data.bookingId);
      await callTelegramApi('answerWidgetQuery', { widget_query_id: query.id });
      if (booking) {
        return await sendInteractiveBookingWidget(chatId, booking.shopId);
      }
    }

    // Default response for unhandled queries
    return await callTelegramApi('answerWidgetQuery', { widget_query_id: query.id });
  } catch (err) {
    console.error('Error handling widget_query:', err);
    try {
      await callTelegramApi('answerWidgetQuery', {
        widget_query_id: query.id,
        text: 'Action error',
      });
    } catch {}
  }
});

// Live Walk-In Queue Status check for customers
bot.onText(/\/queue/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const today = toDateKey(new Date());
    const entry = await WaitlistEntry.findOne({
      telegramId: msg.from.id,
      date: today,
      status: { $in: ['waiting', 'called', 'in_chair'] },
    }).sort({ createdAt: -1 });

    if (!entry) {
      return bot.sendMessage(chatId, '🪑 Hozircha siz jonli navbatda emassiz.', { parse_mode: 'HTML' });
    }

    const shop = await ServicesModel.findById(entry.shopId).select('name');
    const shopLabel = escapeHtml(shop?.name?.uz || shop?.name?.en || 'Salon');

    if (entry.status === 'called') {
      return bot.sendMessage(
        chatId,
        `🔔 <b>Navbatingiz keldi! (#${entry.queueNumber})</b>\n🏪 ${shopLabel}\nIltimos, ustangiz oldiga kiring!`,
        { parse_mode: 'HTML' }
      );
    }
    if (entry.status === 'in_chair') {
      return bot.sendMessage(
        chatId,
        `✂️ <b>Siz hozir xizmatdasiz (#${entry.queueNumber})</b>\n🏪 ${shopLabel}`,
        { parse_mode: 'HTML' }
      );
    }

    const ahead = await WaitlistEntry.countDocuments({
      shopId: entry.shopId,
      date: today,
      status: 'waiting',
      queueNumber: { $lt: entry.queueNumber },
    });

    const text =
      `🎟 <b>Sizning navbatingiz: #${entry.queueNumber}</b>\n\n` +
      `🏪 <b>${shopLabel}</b>\n` +
      `👥 Oldingizda: <b>${ahead} kishi</b>\n` +
      `⏳ Taxminiy kutish vaqti: <b>~${Math.max(10, ahead * 20)} daqiqa</b>`;

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('customerBot /queue error:', err);
  }
});

export default bot;
