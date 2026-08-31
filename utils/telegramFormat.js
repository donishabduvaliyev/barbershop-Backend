// Shared formatting helpers used by both Telegram bots (customer-facing
// config/telegramBot.js and shop-owner-facing config/shopControlBot.js) so
// booking cards/messages never drift between the two.
import { t, normalizeLanguage } from './botMessages.js';

export const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// Hand-rolled rather than trusting Intl/toLocaleDateString with a locale
// string — guarantees correct output regardless of the deployed Node's ICU
// build, and gives exact control over tone/casing in Markdown messages.
const WEEKDAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ru: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
  uz: ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'],
};
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
};

export const formatDateTime = (date, lang = 'uz') => {
  const safeLang = normalizeLanguage(lang);
  const d = new Date(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const weekday = WEEKDAYS[safeLang][d.getDay()];
  const month = MONTHS[safeLang][d.getMonth()];

  if (safeLang === 'ru') return `${weekday}, ${d.getDate()} ${month} ${d.getFullYear()}, ${hours}:${minutes}`;
  if (safeLang === 'uz') return `${d.getDate()}-${month}, ${d.getFullYear()}, ${weekday}, ${hours}:${minutes}`;
  return `${weekday}, ${month} ${d.getDate()}, ${d.getFullYear()}, ${hours}:${minutes}`;
};

// Calendar-date-only variant (no time) — used for date-range fields like a
// promotion's validTo, which are stored as UTC midnight and would otherwise
// render a meaningless "00:00" in the message.
export const formatDate = (date, lang = 'uz') => {
  const safeLang = normalizeLanguage(lang);
  // These fields are stored as UTC midnight (see routes/adminPromotions.js's
  // Promotion model) — read the UTC calendar fields, not local ones, so the
  // date shown never rolls back a day for a server running west of UTC.
  const d = new Date(date);
  const day = d.getUTCDate();
  const month = MONTHS[safeLang][d.getUTCMonth()];
  const year = d.getUTCFullYear();

  if (safeLang === 'ru') return `${day} ${month} ${year}`;
  if (safeLang === 'uz') return `${day}-${month}, ${year}`;
  return `${month} ${day}, ${year}`;
};

// Single source of truth for the shop-owner-facing booking card, reused for
// the initial post and every subsequent status edit so the layout never
// drifts. Uses booking.ownerLanguage (snapshotted once — see
// config/shopControlBot.js's notifyShopOwnerOfNewBooking).
export const formatBookingCard = (booking, statusLine) => {
  const lang = normalizeLanguage(booking.ownerLanguage);
  const lines = [
    t(lang, 'owner.cardTitle'),
    DIVIDER,
    `${t(lang, 'owner.cardShop')} ${booking.shopName}`,
    `${t(lang, 'owner.cardClient')} ${booking.userName}`,
    `${t(lang, 'owner.cardTelegram')} @${booking.userTelegramUsername || booking.userTelegramId}`,
    `${t(lang, 'owner.cardPhone')} ${booking.userNumber}`,
    `${t(lang, 'owner.cardTime')} ${formatDateTime(booking.requestedTime, lang)}`,
  ];
  if (booking.serviceName) {
    lines.push(`${t(lang, 'owner.cardService')} ${booking.serviceName}${booking.price ? ` — ${booking.price}` : ''}`);
  }
  if (booking.staffName) {
    lines.push(`${t(lang, 'owner.cardBarber')} ${booking.staffName}`);
  }
  if (statusLine) {
    lines.push(DIVIDER, statusLine);
  }
  return lines.join('\n');
};
