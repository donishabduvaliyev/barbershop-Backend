import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '12h';

// Issued after routes/adminAuth.js verifies a real Telegram identity and
// resolves it to a shop the caller owns — everything downstream trusts only
// this token's shopId, never anything the client sends directly.
export function signAdminToken({ telegramId, shopId }) {
  return jwt.sign({ telegramId, shopId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyAdminToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware: every /api/admin/* route (except auth itself) is
// scoped to req.shopId — the actual access boundary between shops.
export function requireShopAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyAdminToken(token);

  if (!payload) {
    return res.status(401).json({ message: 'Please log in again.' });
  }

  req.shopId = payload.shopId;
  req.telegramId = payload.telegramId;
  next();
}
