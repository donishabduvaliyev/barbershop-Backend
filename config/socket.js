// Holds the single Socket.io server instance created in server.js. Kept in
// its own module (rather than importing server.js from everywhere) so any
// route or bot handler can push a live update without a circular import.
let ioInstance = null;

export function setIO(io) {
  ioInstance = io;
}

// Every admin-panel client joins a room named `shop:<shopId>` on connect
// (see the io.use auth middleware in server.js) — this is the only place a
// shop's live events go, so one shop's browser tab never sees another
// shop's data.
export function emitToShop(shopId, event, payload) {
  if (!ioInstance || !shopId) return;
  ioInstance.to(`shop:${shopId}`).emit(event, payload);
}
