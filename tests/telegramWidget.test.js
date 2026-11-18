import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import User from '../models/userdata.js';
import {
  calculateShopSlotsForDate,
  buildBookingWidgetHtml,
  buildTicketWidgetHtml,
  buildCompactFallbackKeyboard,
} from '../services/telegramWidgetService.js';
import {
  formatCustomerConfirmedCardHTML,
  formatShopOwnerBookingCardHTML,
  escapeHtml,
} from '../utils/telegramFormat.js';
import {
  callTelegramApi,
  sendInteractiveBookingWidget,
  sendInteractiveTicketWidget,
} from '../config/telegramBot.js';

async function createSampleShop() {
  const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return ServicesModel.create({
    id: Math.floor(Math.random() * 1_000_000_000),
    name: { en: 'Royal Cut Barbershop', uz: 'Qirollik Sartaroshxonasi', ru: 'Королевский Барбершоп' },
    category: 'Barbershop',
    description: { en: 'Luxury grooming', uz: 'Hashamatli xizmat', ru: 'Люксовые стрижки' },
    image: 'https://placehold.co/400x300',
    phone: '+998949827070',
    address: 'Namangan, Navoi 12',
    location: { type: 'Point', coordinates: [71.67, 41.00] },
    capacity: 2,
    isOperational: true,
    workingHours: [
      {
        days: daysOfWeek,
        from: '09:00',
        to: '20:00',
      },
    ],
    staff: [
      {
        name: 'Jasur Barber',
        photo: 'https://placehold.co/100',
        rating: 4.9,
        reviewsCount: 15,
        isAvailableNow: true,
      },
      {
        name: 'Alisher Master',
        photo: 'https://placehold.co/100',
        rating: 4.8,
        reviewsCount: 12,
        isAvailableNow: true,
      },
    ],
  });
}

beforeAll(async () => {
  await setupTestDb();
}, 60_000);

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  vi.restoreAllMocks();
});

describe('Telegram Bot API 10.4 Widget Service', () => {
  it('calculateShopSlotsForDate calculates correct hourly slots respecting capacity', async () => {
    const shop = await createSampleShop();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    // No bookings yet -> all hours from 09:00 to 19:00 should be open
    const slots = await calculateShopSlotsForDate(shop, dateStr);
    expect(slots.length).toBe(11); // 9 to 19 inclusive = 11 hours
    expect(slots[0].time).toBe('09:00');
    expect(slots[0].isAvailable).toBe(true);

    // Book 2 slots at 10:00 (capacity is 2)
    const slotTime = new Date(tomorrow);
    slotTime.setHours(10, 0, 0, 0);

    await Booking.create([
      {
        shopId: shop._id,
        shopName: shop.name.en,
        userTelegramId: -101,
        userName: 'Customer 1',
        userNumber: '+998901111111',
        requestedTime: slotTime,
        status: 'confirmed',
      },
      {
        shopId: shop._id,
        shopName: shop.name.en,
        userTelegramId: -102,
        userName: 'Customer 2',
        userNumber: '+998902222222',
        requestedTime: slotTime,
        status: 'pending',
      },
    ]);

    const updatedSlots = await calculateShopSlotsForDate(shop, dateStr);
    const tenAmSlot = updatedSlots.find((s) => s.time === '10:00');
    expect(tenAmSlot).toBeDefined();
    expect(tenAmSlot.isAvailable).toBe(false);
    expect(tenAmSlot.bookedCount).toBe(2);

    const elevenAmSlot = updatedSlots.find((s) => s.time === '11:00');
    expect(elevenAmSlot.isAvailable).toBe(true);
    expect(elevenAmSlot.bookedCount).toBe(0);
  });

  it('buildBookingWidgetHtml generates valid micro-HTML strictly under Telegram 32KB budget', async () => {
    const shop = await createSampleShop();
    const todayStr = new Date().toISOString().slice(0, 10);
    const slots = [
      { time: '10:00', hour: 10, isAvailable: true, bookedCount: 0, capacity: 2 },
      { time: '11:00', hour: 11, isAvailable: false, bookedCount: 2, capacity: 2 },
      { time: '12:00', hour: 12, isAvailable: true, bookedCount: 1, capacity: 2 },
    ];

    const html = buildBookingWidgetHtml({
      shop,
      dateStr: todayStr,
      slots,
      staffList: shop.staff,
      selectedStaffId: '',
      selectedTime: '10:00',
      lang: 'uz',
    });

    const byteLength = Buffer.byteLength(html, 'utf8');
    // Telegram Bot API 10.4 widget payload limit: 32,768 bytes
    expect(byteLength).toBeLessThan(32 * 1024);
    expect(byteLength).toBeGreaterThan(1000); // Has styling and functional logic

    // Verifies key UI elements & scripts
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Telegram.Widget.postQuery');
    expect(html).toContain('Qirollik Sartaroshxonasi');
    expect(html).toContain('Jasur Barber');
    expect(html).toContain('10:00');
  });

  it('buildTicketWidgetHtml generates self-contained countdown ticket widget under 32KB', async () => {
    const shop = await createSampleShop();
    const futureTime = new Date(Date.now() + 2 * 3600 * 1000); // 2 hours from now
    const booking = await Booking.create({
      shopId: shop._id,
      shopName: shop.name.uz,
      userTelegramId: -100,
      userName: 'Sardor',
      userNumber: '+998901234567',
      staffName: 'Jasur Barber',
      requestedTime: futureTime,
      status: 'confirmed',
      userLanguage: 'uz',
    });

    const html = buildTicketWidgetHtml({ booking, lang: 'uz' });
    const byteLength = Buffer.byteLength(html, 'utf8');

    expect(byteLength).toBeLessThan(32 * 1024);
    expect(html).toContain('countdown');
    expect(html).toContain('TASDIQLANDI');
    expect(html).toContain('Qirollik Sartaroshxonasi');
    expect(html).toContain('Jasur Barber');
    expect(html).toContain('rescheduleBooking');
    expect(html).toContain('cancelBooking');
  });

  it('buildCompactFallbackKeyboard formats inline rows for clients without sendWidget', async () => {
    const shop = await createSampleShop();
    const slots = [
      { time: '09:00', hour: 9, isAvailable: true },
      { time: '10:00', hour: 10, isAvailable: true },
      { time: '11:00', hour: 11, isAvailable: true },
      { time: '12:00', hour: 12, isAvailable: false },
      { time: '13:00', hour: 13, isAvailable: true },
    ];

    const keyboard = buildCompactFallbackKeyboard({
      shop,
      dateStr: '2026-11-15',
      slots,
      lang: 'en',
      webAppUrl: 'https://barbershop-telegram-bot.netlify.app',
    });

    expect(keyboard.inline_keyboard).toBeDefined();
    // First row should have 3 available slots with native success (green) style
    expect(keyboard.inline_keyboard[0].length).toBe(3);
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe(`wslot_${shop._id}_2026-11-15_9`);
    expect(keyboard.inline_keyboard[0][0].style).toBe('success');

    // Second row should have remaining available slots (13:00) with success style
    expect(keyboard.inline_keyboard[1].length).toBe(1);
    expect(keyboard.inline_keyboard[1][0].callback_data).toBe(`wslot_${shop._id}_2026-11-15_13`);
    expect(keyboard.inline_keyboard[1][0].style).toBe('success');

    // Last row should have Web App launcher with native primary (blue) style
    const lastRow = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1];
    expect(lastRow[0].web_app.url).toBe(`https://barbershop-telegram-bot.netlify.app/service/${shop._id}`);
    expect(lastRow[0].style).toBe('primary');
  });

  it('formatCustomerConfirmedCardHTML generates luxury card with <blockquote expandable> and catalog info without policy', async () => {
    const shop = await createSampleShop();
    const booking = await Booking.create({
      shopId: shop._id,
      shopName: shop.name.uz,
      userTelegramId: -201,
      userName: 'Bobur',
      userNumber: '+998901234567',
      staffName: 'Jasur Barber',
      serviceName: 'Soch turmagi (Fade)',
      price: 80000,
      requestedTime: new Date(Date.now() + 3600_000),
      status: 'confirmed',
      userLanguage: 'uz',
    });

    const html = formatCustomerConfirmedCardHTML({ booking, shop, lang: 'uz' });
    expect(html).toContain('<b>💈 SMARTCHAIR');
    expect(html).toContain('<blockquote expandable>');
    expect(html).toContain('</blockquote>');
    expect(html).toContain('Qirollik Sartaroshxonasi');
    expect(html).toContain('Namangan, Navoi 12');
    expect(html).toContain('https://www.google.com/maps?q=41,71.67');
    expect(html).toContain('+998949827070');
    expect(html).toContain('Jasur Barber');
    expect(html).toContain('80,000 UZS');
    expect(html).toContain('09:00 - 20:00');
    // Verifies cancellation policy is omitted per user preference
    expect(html).not.toContain('policy');
    expect(html).not.toContain('qoidasi');
  });

  it('formatShopOwnerBookingCardHTML generates structured owner card with <blockquote expandable>', async () => {
    const shop = await createSampleShop();
    const booking = await Booking.create({
      shopId: shop._id,
      shopName: shop.name.uz,
      userTelegramId: -202,
      userName: 'Nodir',
      userNumber: '+998907654321',
      userTelegramUsername: 'nodir_dev',
      staffName: 'Alisher Master',
      serviceName: 'Soqol tekislash',
      price: 50000,
      requestedTime: new Date(Date.now() + 3600_000),
      status: 'pending',
      userLanguage: 'uz',
      ownerLanguage: 'uz',
    });

    const html = formatShopOwnerBookingCardHTML(booking, null, shop);
    expect(html).toContain('<b>💈 SMARTCHAIR');
    expect(html).toContain('<blockquote expandable>');
    expect(html).toContain('</blockquote>');
    expect(html).toContain('Nodir');
    expect(html).toContain('<code>+998907654321</code>');
    expect(html).toContain('https://t.me/nodir_dev');
    expect(html).toContain('Alisher Master');
    expect(html).toContain('50,000 UZS');
  });
});

describe('Bot Dual-Mode & Fallback Execution', () => {
  it('sendInteractiveBookingWidget executes and falls back safely if sendWidget is unsupported', async () => {
    const shop = await createSampleShop();
    const fakeChatId = -999; // Synthetic id prevents real Telegram API polling

    // Should return false cleanly for synthetic test id
    const result = await sendInteractiveBookingWidget(fakeChatId, shop);
    expect(result).toBe(false);
  });

  it('sendInteractiveBookingWidget calls Telegram sendWidget when supported', async () => {
    const shop = await createSampleShop();
    const fakeChatId = 123456789;

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 888 } }),
    });

    try {
      const res = await sendInteractiveBookingWidget(fakeChatId, shop);
      expect(res.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sendWidget'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Qirollik Sartaroshxonasi'),
        })
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  it('sendInteractiveTicketWidget executes without crashing on confirmed booking', async () => {
    const shop = await createSampleShop();
    const booking = await Booking.create({
      shopId: shop._id,
      shopName: shop.name.en,
      userTelegramId: -999,
      userName: 'Test User',
      userNumber: '+998901234567',
      requestedTime: new Date(Date.now() + 3600_000),
      status: 'confirmed',
      userLanguage: 'en',
    });

    // Synthetic negative id skips real network call
    const result = await sendInteractiveTicketWidget(booking.userTelegramId, booking);
    expect(result).toBeUndefined(); // Returns early for synthetic negative chat id
  });

  it('sendInteractiveTicketWidget calls sendWidget with celebratory effect for real chat id', async () => {
    const shop = await createSampleShop();
    const booking = await Booking.create({
      shopId: shop._id,
      shopName: shop.name.en,
      userTelegramId: 987654321,
      userName: 'Celebration User',
      userNumber: '+998909876543',
      requestedTime: new Date(Date.now() + 3600_000),
      status: 'confirmed',
      userLanguage: 'en',
    });

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 999 } }),
    });

    try {
      const res = await sendInteractiveTicketWidget(booking.userTelegramId, booking);
      expect(res.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sendWidget'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('5046509860389126464'),
        })
      );
    } finally {
      global.fetch = origFetch;
    }
  });
});
