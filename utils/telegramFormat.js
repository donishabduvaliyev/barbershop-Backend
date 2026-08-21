// Shared formatting helpers used by both Telegram bots (customer-facing
// config/telegramBot.js and shop-owner-facing config/shopControlBot.js) so
// booking cards/messages never drift between the two.

export const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

export const formatDateTime = (date) =>
  new Date(date).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

// Single source of truth for the shop-owner-facing booking card, reused for
// the initial post and every subsequent status edit so the layout never drifts.
export const formatBookingCard = (booking, statusLine) => {
  const lines = [
    '💈 *TEZKOR* · New Booking Request',
    DIVIDER,
    `🏪 *Shop:*  ${booking.shopName}`,
    `👤 *Client:*  ${booking.userName}`,
    `🔗 *Telegram:*  @${booking.userTelegramUsername || booking.userTelegramId}`,
    `📞 *Phone:*  ${booking.userNumber}`,
    `🗓 *Time:*  ${formatDateTime(booking.requestedTime)}`,
  ];
  if (booking.serviceName) {
    lines.push(`✂️ *Service:*  ${booking.serviceName}${booking.price ? ` — ${booking.price}` : ''}`);
  }
  if (booking.staffName) {
    lines.push(`💇 *Barber:*  ${booking.staffName}`);
  }
  if (statusLine) {
    lines.push(DIVIDER, statusLine);
  }
  return lines.join('\n');
};
