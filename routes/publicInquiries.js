import express from 'express';
import rateLimit from 'express-rate-limit';
import BusinessInquiry from '../models/businessInquiry.js';
import DataDeletionRequest from '../models/dataDeletionRequest.js';
import { notifyUser } from '../config/telegramBot.js';

const router = express.Router();

const publicFormLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many submissions from this IP. Please try again in a few minutes or call +998 94 982 70 70.',
  },
});

function sanitizeText(value, maxLen = 200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

// POST /api/public/business-inquiries
router.post('/business-inquiries', publicFormLimiter, async (req, res) => {
  try {
    const businessName = sanitizeText(req.body?.businessName, 120);
    const ownerName = sanitizeText(req.body?.ownerName, 120);
    const phone = sanitizeText(req.body?.phone, 40);
    const category = sanitizeText(req.body?.category || 'barber', 60);
    const city = sanitizeText(req.body?.city || 'Namangan', 80);
    const staffCount = sanitizeText(req.body?.staffCount || '1-2', 30);
    const telegramOrInstagram = sanitizeText(req.body?.telegramOrInstagram, 120);
    const message = sanitizeText(req.body?.message, 1000);
    const consentAccepted = Boolean(req.body?.consentAccepted);
    const rawLang = sanitizeText(req.body?.language || 'uz', 5);
    const language = ['uz', 'ru', 'en'].includes(rawLang) ? rawLang : 'uz';

    if (!businessName || !ownerName || !phone || phone.replace(/\D/g, '').length < 7) {
      return res.status(400).json({
        success: false,
        message: 'Business name, owner name, and a valid phone number are required.',
      });
    }

    if (!consentAccepted) {
      return res.status(400).json({
        success: false,
        message: 'Consent to personal data processing (Law O‘RQ-547) is required.',
      });
    }

    const inquiry = await BusinessInquiry.create({
      businessName,
      ownerName,
      phone,
      category,
      city,
      staffCount,
      telegramOrInstagram,
      message,
      consentAccepted,
      language,
    });

    const operatorChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (operatorChatId) {
      const alertLines = [
        '🏢 <b>Yangi Biznes Hamkor So‘rovi (SmartChair B2B)</b>',
        '',
        `💈 <b>Biznes nomi:</b> ${businessName}`,
        `👤 <b>Egasi / Mas’ul:</b> ${ownerName}`,
        `📞 <b>Telefon:</b> ${phone}`,
        `📂 <b>Yo‘nalish:</b> ${category}`,
        `📍 <b>Shahar / Manzil:</b> ${city}`,
        `👥 <b>Ustalar soni:</b> ${staffCount}`,
        telegramOrInstagram ? `💬 <b>Telegram / Instagram:</b> ${telegramOrInstagram}` : null,
        message ? `📝 <b>Izoh:</b> ${message}` : null,
        `🌐 <b>Til:</b> ${language.toUpperCase()}`,
      ]
        .filter(Boolean)
        .join('\n');

      await notifyUser(operatorChatId, alertLines);
    }

    return res.status(201).json({
      success: true,
      inquiryId: String(inquiry._id),
      message: 'Your business inquiry has been received. We will contact you shortly.',
    });
  } catch (err) {
    console.error('Error creating business inquiry:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to submit business inquiry. Please call +998 94 982 70 70 directly.',
    });
  }
});

// POST /api/public/data-deletion-requests
router.post('/data-deletion-requests', publicFormLimiter, async (req, res) => {
  try {
    const phone = sanitizeText(req.body?.phone, 40);
    const telegramUsername = sanitizeText(req.body?.telegramUsername, 80);
    const reason = sanitizeText(req.body?.reason, 500);
    const confirmDeletion = Boolean(req.body?.confirmDeletion);
    const rawLang = sanitizeText(req.body?.language || 'uz', 5);
    const language = ['uz', 'ru', 'en'].includes(rawLang) ? rawLang : 'uz';

    if ((!phone || phone.replace(/\D/g, '').length < 7) && !telegramUsername) {
      return res.status(400).json({
        success: false,
        message: 'Please provide either your registered phone number or Telegram username.',
      });
    }

    if (!confirmDeletion) {
      return res.status(400).json({
        success: false,
        message: 'Please confirm that you want to permanently delete your account and personal data.',
      });
    }

    const deletionReq = await DataDeletionRequest.create({
      phone,
      telegramUsername,
      reason,
      confirmDeletion,
      language,
    });

    const operatorChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (operatorChatId) {
      const alertLines = [
        '🗑️ <b>Shaxsiy Ma’lumotlarni O‘chirish So‘rovi (O‘RQ-547 / App Store)</b>',
        '',
        phone ? `📞 <b>Telefon:</b> ${phone}` : null,
        telegramUsername ? `💬 <b>Telegram:</b> ${telegramUsername}` : null,
        reason ? `📝 <b>Sabab:</b> ${reason}` : null,
        `🆔 <b>So‘rov ID:</b> ${deletionReq._id}`,
      ]
        .filter(Boolean)
        .join('\n');

      await notifyUser(operatorChatId, alertLines);
    }

    return res.status(201).json({
      success: true,
      requestId: String(deletionReq._id),
      message: 'Your account and personal data deletion request has been registered and will be processed within 72 hours.',
    });
  } catch (err) {
    console.error('Error creating data deletion request:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to submit deletion request. Please contact +998 94 982 70 70.',
    });
  }
});

export default router;
