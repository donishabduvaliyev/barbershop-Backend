import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '12h';
const IDENTITY_TOKEN_TTL = '10m';

// Issued after routes/adminAuth.js verifies a real Telegram identity and
// resolves it to a shop the caller owns — everything downstream trusts only
// this token's shopId, never anything the client sends directly.
export function signAdminToken({ telegramId, shopId }) {
  return jwt.sign({ telegramId, shopId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Proves "this is really telegramId" without committing to a shop yet —
// used when one Telegram account owns several shops and needs to pick one
// (routes/adminAuth.js's /select-shop). Short-lived since it's only meant
// to bridge the gap between verifying identity and choosing a shop.
export function signIdentityToken({ telegramId }) {
  return jwt.sign({ telegramId, shopId: null }, JWT_SECRET, { expiresIn: IDENTITY_TOKEN_TTL });
}

export function verifyAdminToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware: every /api/admin/* route (except auth itself) is
// scoped to req.shopId — the actual access boundary between shops. An
// identity-only token (no shopId — see signIdentityToken) is deliberately
// rejected here; it's only valid for /select-shop.
export function requireShopAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyAdminToken(token);

  if (!payload || !payload.shopId) {
    return res.status(401).json({ message: 'Please log in again.' });
  }

  req.shopId = payload.shopId;
  req.telegramId = payload.telegramId;
  next();
}
