// Lets services/bookingActions.js ask the shop-control bot to edit a
// booking's Telegram card in place, without importing config/shopControlBot.js
// directly (that file imports bookingActions.js to handle its own button
// callbacks, so a direct import would be circular). shopControlBot.js
// registers the real implementation once at startup.
let cardEditor = null;

export function registerCardEditor(fn) {
  cardEditor = fn;
}

// No-op (and safely logs) if the shop-control bot hasn't registered yet, or
// the booking was never posted to Telegram (e.g. created directly by an admin).
export async function editBookingCard(booking, statusLine) {
  if (!cardEditor) return;
  try {
    await cardEditor(booking, statusLine);
  } catch (err) {
    console.error('Failed to edit booking card:', err.message);
  }
}
