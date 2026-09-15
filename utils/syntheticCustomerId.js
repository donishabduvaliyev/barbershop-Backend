// A walk-in customer with no Telegram account still needs a `telegramId`
// (Booking, Customer, and every notification/aggregate lookup key off it) —
// real Telegram ids are always positive, so a negative one is guaranteed to
// never collide with a real one. Not cryptographically unique, just
// astronomically unlikely to collide for this low-volume, manually-triggered
// use case (the unique index on Customer still guards against it either way).
export function generateSyntheticTelegramId() {
  return -(Date.now() + Math.floor(Math.random() * 1_000_000));
}
