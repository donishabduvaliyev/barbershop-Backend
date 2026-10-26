import jwt from 'jsonwebtoken';

function getAdminJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET environment variable is required in production.');
    }
    const fallback = process.env.TELEGRAM_BOT_TOKEN;
    if (!fallback) {
      throw new Error('FATAL: Neither JWT_SECRET nor TELEGRAM_BOT_TOKEN is configured.');
    }
    return fallback;
  }
  return secret;
}

const TOKEN_TTL = '12h';
const IDENTITY_TOKEN_TTL = '10m';

// Issued after routes/adminAuth.js verifies a real Telegram identity and
// resolves it to a shop the caller owns — everything downstream trusts only
// this token's shopId, never anything the client sends directly.
export function signAdminToken({ telegramId, shopId }) {
  return jwt.sign({ telegramId, shopId }, getAdminJwtSecret(), { expiresIn: TOKEN_TTL });
}

// Proves "this is really telegramId" without committing to a shop yet —
// used when one Telegram account owns several shops and needs to pick one
// (routes/adminAuth.js's /select-shop). Short-lived since it's only meant
// to bridge the gap between verifying identity and choosing a shop.
export function signIdentityToken({ telegramId }) {
  return jwt.sign({ telegramId, shopId: null }, getAdminJwtSecret(), { expiresIn: IDENTITY_TOKEN_TTL });
}

// Platform-wide session, not scoped to any one shop — see
// routes/superAdmin.js and requireSuperAdmin below. Same TTL as a normal
// admin session.
export function signSuperAdminToken({ telegramId }) {
  return jwt.sign({ telegramId, shopId: null, role: 'superadmin' }, getAdminJwtSecret(), { expiresIn: TOKEN_TTL });
}

export function verifyAdminToken(token) {
  try {
    return jwt.verify(token, getAdminJwtSecret());
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

// Express middleware for /api/superadmin/* — rejects unless the token was
// issued by signSuperAdminToken (role: 'superadmin'). Deliberately a
// separate check from requireShopAdmin rather than "any token with no
// shopId", since an identity-only token (signIdentityToken, mid-shop-select)
// also has shopId: null and must NOT be treated as super-admin access.
export function requireSuperAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyAdminToken(token);

  if (!payload || payload.role !== 'superadmin') {
    return res.status(401).json({ message: 'Please log in again.' });
  }

  req.telegramId = payload.telegramId;
  next();
}
