import express from 'express';
import shopRoutes from '../shops.js';
import userRouter from '../userData.js';
import authRouter from '../auth.js';
import trackRouter from '../track.js';

// Dedicated Web (Telegram Mini App) module router.
// Mirrors the root /api/* endpoints under /api/web/* while tagging incoming
// requests with `req.clientPlatform = 'web'`.
const router = express.Router();

router.use((req, _res, next) => {
  req.clientPlatform = 'web';
  next();
});

router.use('/shops', shopRoutes);
router.use('/user', userRouter);
router.use('/auth', authRouter);
router.use('/track', trackRouter);

export default router;
