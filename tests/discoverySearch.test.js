import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupTestDb, teardownTestDb, clearTestDb } from './setupDb.js';
import shopsRouter from '../routes/shops.js';
import ServicesModel from '../models/shopData.js';
import SearchCategory from '../models/searchCategory.js';

let server;
let baseUrl;

describe('Multilingual Discovery Search (Uzbek, Russian, English)', () => {
  beforeAll(async () => {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    app.use('/api/shops', shopsRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();

    // Create test search shelf
    await SearchCategory.create({
      key: 'all-shops',
      label: { en: 'All Shops', uz: 'Barcha salonlar', ru: 'Все салоны' },
      icon: 'sparkles',
      type: 'auto',
      autoRule: 'topRated',
      isActive: true,
      order: 1,
    });

    // Create sample shop: Barbershop
    await ServicesModel.create({
      id: 101,
      name: { en: 'Top Barber Club', uz: 'Top Barber Klubi', ru: 'Топ Барбер Клуб' },
      category: 'Barbershop',
      description: {
        en: 'Premium barbershop for gentlemen',
        uz: 'Erkaklar uchun zamonaviy sartaroshxona xizmatlari',
        ru: 'Премиум парикмахерская и барбершоп для мужчин',
      },
      image: 'https://example.com/barber.jpg',
      phone: '+998901234567',
      address: 'Namangan shahar, Navoiy ko\'chasi 12',
      location: { type: 'Point', coordinates: [71.6726, 40.9983] },
      rating: 4.9,
      isOperational: true,
      services: [
        {
          name: { en: 'Classic Haircut', uz: 'Klassik soch olish', ru: 'Классическая стрижка' },
          price: 80000,
          durationMinutes: 45,
          isActive: true,
        },
        {
          name: { en: 'Beard Trim', uz: 'Soqol tekislash', ru: 'Оформление бороды' },
          price: 40000,
          durationMinutes: 30,
          isActive: true,
        },
      ],
    });

    // Create sample shop: Nail & Beauty Salon
    await ServicesModel.create({
      id: 102,
      name: { en: 'Glamour Beauty Studio', uz: 'Glamur Go\'zallik Studiyasi', ru: 'Гламур Бьюти Студия' },
      category: 'Nail Salon',
      description: {
        en: 'Professional manicure and pedicure',
        uz: 'Professional manikyur va pedikyur xizmati',
        ru: 'Профессиональный ногтевой салон',
      },
      image: 'https://example.com/nails.jpg',
      phone: '+998907654321',
      address: 'Namangan shahar, Bobur shoh ko\'chasi 5',
      location: { type: 'Point', coordinates: [71.6800, 41.0000] },
      rating: 4.8,
      isOperational: true,
      services: [
        {
          name: { en: 'Gel Nails', uz: 'Gel lak qoplash', ru: 'Покрытие гель-лак' },
          price: 120000,
          durationMinutes: 60,
          isActive: true,
        },
      ],
    });
  });

  it('finds Barbershop when searching with Uzbek term "sartaroshxona"', async () => {
    const res = await fetch(`${baseUrl}/api/shops/discovery-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'sartaroshxona' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shelf = body.categories.find((c) => c.key === 'all-shops');
    expect(shelf).toBeDefined();
    expect(shelf.shops.length).toBe(1);
    expect(shelf.shops[0].id).toBe(101);
  });

  it('finds Barbershop when searching with Russian term "парикмахерская"', async () => {
    const res = await fetch(`${baseUrl}/api/shops/discovery-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'парикмахерская' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shelf = body.categories.find((c) => c.key === 'all-shops');
    expect(shelf).toBeDefined();
    expect(shelf.shops.length).toBe(1);
    expect(shelf.shops[0].id).toBe(101);
  });

  it('finds shop by service name in Uzbek ("soch olish")', async () => {
    const res = await fetch(`${baseUrl}/api/shops/discovery-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'soch olish' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shelf = body.categories.find((c) => c.key === 'all-shops');
    expect(shelf.shops.some((s) => s.id === 101)).toBe(true);
  });

  it('finds shop by service name in Russian ("стрижка")', async () => {
    const res = await fetch(`${baseUrl}/api/shops/discovery-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'стрижка' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shelf = body.categories.find((c) => c.key === 'all-shops');
    expect(shelf.shops.some((s) => s.id === 101)).toBe(true);
  });

  it('finds Nail salon when searching with Uzbek term "manikyur" and Russian term "маникюр"', async () => {
    const uzRes = await fetch(`${baseUrl}/api/shops/discovery-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'manikyur' }),
    });
    expect(uzRes.status).toBe(200);
    const uzBody = await uzRes.json();
    const uzShelf = uzBody.categories.find((c) => c.key === 'all-shops');
    expect(uzShelf.shops.some((s) => s.id === 102)).toBe(true);

    const ruRes = await fetch(`${baseUrl}/api/shops/discovery-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchTerm: 'маникюр' }),
    });
    expect(ruRes.status).toBe(200);
    const ruBody = await ruRes.json();
    const ruShelf = ruBody.categories.find((c) => c.key === 'all-shops');
    expect(ruShelf.shops.some((s) => s.id === 102)).toBe(true);
  });
});
