// Shared formatting helpers used by both Telegram bots (customer-facing
// config/telegramBot.js and shop-owner-facing config/shopControlBot.js) so
// booking cards/messages never drift between the two.
import { t, normalizeLanguage } from './botMessages.js';
import { escapeMarkdown } from './escapeMarkdown.js';

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

export const escapeHtml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// Generates luxury customer appointment ticket HTML with native <blockquote expandable>
export const formatCustomerConfirmedCardHTML = ({ booking, shop, lang = 'uz' }) => {
  const safeLang = normalizeLanguage(lang);
  const formattedDate = formatDateTime(booking.requestedTime, safeLang);
  const mapsUrl = shop?.location?.coordinates?.length === 2
    ? `https://www.google.com/maps?q=${shop.location.coordinates[1]},${shop.location.coordinates[0]}`
    : '';

  const workingHours = shop?.workingHours?.[0];
  const hoursText = workingHours ? `${workingHours.from} - ${workingHours.to}` : '';

  const lines = [
    `<b>💈 SMARTCHAIR · ${t(safeLang, 'customer.bookingConfirmedTitle')}</b>`,
    `🟢 <b>${t(safeLang, 'customer.widgetTicketConfirmed')}</b> — 🗓 <b>${formattedDate}</b>`,
    DIVIDER,
    `<blockquote expandable>`,
    `🏪 <b>${t(safeLang, 'owner.cardShop')}</b> ${escapeHtml(booking.shopName)}`,
    shop?.address ? `📍 <b>Manzil:</b> ${escapeHtml(shop.address)}${mapsUrl ? ` (<a href="${mapsUrl}">${t(safeLang, 'customer.viewOnMap')}</a>)` : ''}` : '',
    shop?.phone ? `📞 <b>${t(safeLang, 'owner.cardPhone')}</b> ${escapeHtml(shop.phone)}` : '',
    booking.staffName ? `💇 <b>${t(safeLang, 'owner.cardBarber')}</b> ${escapeHtml(booking.staffName)}` : '',
    booking.serviceName ? `✂️ <b>${t(safeLang, 'owner.cardService')}</b> ${escapeHtml(booking.serviceName)}${booking.price ? ` — <b>${Number(booking.price).toLocaleString()} UZS</b>` : ''}` : '',
    hoursText ? `⏰ <b>Ish vaqti:</b> ${hoursText}` : '',
    `</blockquote>`,
    '',
    `<i>${t(safeLang, 'customer.seeYouThere')}</i>`,
  ].filter(Boolean);

  return lines.join('\n');
};

// Generates luxury shop-owner notification card HTML with native <blockquote expandable>
export const formatShopOwnerBookingCardHTML = (booking, statusLine, shop = null) => {
  const lang = normalizeLanguage(booking.ownerLanguage);
  const telegramContact = booking.userTelegramUsername
    ? `<a href="https://t.me/${escapeHtml(booking.userTelegramUsername)}">@${escapeHtml(booking.userTelegramUsername)}</a>`
    : t(lang, 'owner.cardNoTelegramUsername');

  const lines = [
    `<b>💈 SMARTCHAIR · ${t(lang, 'owner.cardTitle')}</b>`,
    statusLine ? statusLine : `🟡 <b>${t(lang, 'customer.widgetTicketPending')}</b>`,
    DIVIDER,
    `<blockquote expandable>`,
    `👤 <b>${t(lang, 'owner.cardClient')}</b> ${escapeHtml(booking.userName)}`,
    `📞 <b>${t(lang, 'owner.cardPhone')}</b> <code>${escapeHtml(booking.userNumber)}</code>`,
    `🔗 <b>${t(lang, 'owner.cardTelegram')}</b> ${telegramContact}`,
    `🗓 <b>${t(lang, 'owner.cardTime')}</b> <b>${formatDateTime(booking.requestedTime, lang)}</b>`,
    `🏪 <b>${t(lang, 'owner.cardShop')}</b> ${escapeHtml(booking.shopName)}`,
    booking.staffName ? `💇 <b>${t(lang, 'owner.cardBarber')}</b> ${escapeHtml(booking.staffName)}` : '',
    booking.serviceName ? `✂️ <b>${t(lang, 'owner.cardService')}</b> ${escapeHtml(booking.serviceName)}${booking.price ? ` — <b>${Number(booking.price).toLocaleString()} UZS</b>` : ''}` : '',
    shop?.address ? `📍 <b>Filial:</b> ${escapeHtml(shop.address)}` : '',
    `</blockquote>`,
  ].filter(Boolean);

  return lines.join('\n');
};

// Single source of truth for the shop-owner-facing booking card, reused for
// the initial post and every subsequent status edit so the layout never
// drifts. Uses booking.ownerLanguage (snapshotted once — see
// config/shopControlBot.js's notifyShopOwnerOfNewBooking).
export const formatBookingCard = (booking, statusLine) => {
  const lang = normalizeLanguage(booking.ownerLanguage);
  // A real t.me/<username> link only exists when the customer has set a
  // public Telegram username — Telegram has no way to open a chat with an
  // arbitrary numeric user id, so falling back to "@<id>" (as this used to)
  // rendered as dead, unclickable text instead of a working link.
  const telegramContact = booking.userTelegramUsername
    ? `https://t.me/${escapeMarkdown(booking.userTelegramUsername)}`
    : t(lang, 'owner.cardNoTelegramUsername');
  const lines = [
    t(lang, 'owner.cardTitle'),
    DIVIDER,
    `${t(lang, 'owner.cardShop')} ${escapeMarkdown(booking.shopName)}`,
    `${t(lang, 'owner.cardClient')} ${escapeMarkdown(booking.userName)}`,
    `${t(lang, 'owner.cardTelegram')} ${telegramContact}`,
    `${t(lang, 'owner.cardPhone')} ${escapeMarkdown(booking.userNumber)}`,
    `${t(lang, 'owner.cardTime')} ${formatDateTime(booking.requestedTime, lang)}`,
  ];
  if (booking.serviceName) {
    lines.push(`${t(lang, 'owner.cardService')} ${escapeMarkdown(booking.serviceName)}${booking.price ? ` — ${booking.price}` : ''}`);
  }
  if (booking.staffName) {
    lines.push(`${t(lang, 'owner.cardBarber')} ${escapeMarkdown(booking.staffName)}`);
  }
  if (statusLine) {
    lines.push(DIVIDER, statusLine);
  }
  return lines.join('\n');
};
