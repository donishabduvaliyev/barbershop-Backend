import crypto from 'crypto';

// Verifies Telegram WebApp initData per Telegram's documented algorithm:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// Returns the authenticated Telegram user object, or null if invalid/missing.
export function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = Array.from(params.keys())
    .sort()
    .map((key) => `${key}=${params.get(key)}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuffer = Buffer.from(hash, 'hex');
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
  if (hashBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(hashBuffer, calculatedBuffer)) {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

// Express middleware: rejects any request that isn't provably from inside
// Telegram, and attaches the verified user to req.telegramUser so routes
// never have to trust a client-supplied telegram id.
export function requireTelegramAuth(req, res, next) {
  const initData = req.body?.initData || req.headers['x-telegram-init-data'];
  const user = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);

  if (!user) {
    return res.status(401).json({ message: 'Please open this app from Telegram to continue.' });
  }

  req.telegramUser = user;
  next();
}
