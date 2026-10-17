// Holds the single Socket.io server instance created in server.js. Kept in
// its own module (rather than importing server.js from everywhere) so any
// route or bot handler can push a live update without a circular import.
let ioInstance = null;

export function setIO(io) {
  ioInstance = io;
}

export function getIO() {
  return ioInstance;
}

// Emits a live event to a specific customer across all their connected
// devices (both Telegram Web Mini App and React Native Mobile App).
export function emitToUser(telegramId, event, payload) {
  if (!ioInstance || !telegramId) return;
  ioInstance.to(`user:${telegramId}`).emit(event, payload);
}

// Emits a live event to a pending mobile authentication handshake room
// (`auth:<sessionToken>`) when the user confirms login inside Telegram.
export function emitToAuthSession(sessionToken, event, payload) {
  if (!ioInstance || !sessionToken) return;
  ioInstance.to(`auth:${sessionToken}`).emit(event, payload);
}

// Every admin-panel client joins `shop:<shopId>`.
// In addition, whenever a booking (`appointment:update`) is emitted for a
// shop, we automatically fan out:
// 1. `booking:updated` to `user:<userTelegramId>` so the customer's Web &
//    Mobile apps update booking status live on screen.
// 2. `availability:updated` to `public:shop:<shopId>` so any Web or Mobile
//    user currently picking a time slot at this shop sees availability
//    update in real time.
export function emitToShop(shopId, event, payload) {
  if (!ioInstance || !shopId) return;
  const normalizedShopId = shopId?._id ? String(shopId._id) : String(shopId);
  ioInstance.to(`shop:${normalizedShopId}`).emit(event, payload);

  if (event === 'appointment:update' && payload) {
    if (payload.userTelegramId) {
      ioInstance.to(`user:${payload.userTelegramId}`).emit('booking:updated', payload);
    }
    ioInstance.to(`public:shop:${normalizedShopId}`).emit('availability:updated', {
      shopId: normalizedShopId,
      bookingId: payload._id,
      requestedTime: payload.requestedTime,
      status: payload.status,
      staffId: payload.staffId || null,
    });
  }
}

