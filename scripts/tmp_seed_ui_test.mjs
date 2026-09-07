import 'dotenv/config';
import mongoose from 'mongoose';
import ServicesModel from '../models/shopData.js';

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

await mongoose.connect(process.env.MONGO_URI);

await ServicesModel.deleteMany({ 'name.en': { $in: ['UI AvailNow Shop A', 'UI AvailNow Shop B'] } });

const shopA = await ServicesModel.create({
  id: Date.now() % 1_000_000_000,
  name: { en: 'UI AvailNow Shop A', uz: "UI AvailNow Do'kon A", ru: 'UI AvailNow Магазин А' },
  category: 'Barbershop',
  description: { en: 'Test', uz: 'Test', ru: 'Тест' },
  image: 'https://placehold.co/600x400?text=Shop+A',
  phone: '+998900000201',
  address: 'UI test address A',
  location: { type: 'Point', coordinates: [69.24, 41.30] },
  isOperational: true,
  workingHours: [{ days: ALL_DAYS, from: '08:00', to: '22:00' }],
  services: [{ name: { en: 'Haircut Deluxe', uz: 'Soch Olish Delyuks', ru: 'Стрижка Делюкс' }, price: 60000, durationMinutes: 30 }],
  staff: [{ name: 'Bekzod', daysOff: [], serviceIds: [] }],
});
const shopB = await ServicesModel.create({
  id: (Date.now() + 1) % 1_000_000_000,
  name: { en: 'UI AvailNow Shop B', uz: "UI AvailNow Do'kon B", ru: 'UI AvailNow Магазин Б' },
  category: 'Barbershop',
  description: { en: 'Test', uz: 'Test', ru: 'Тест' },
  image: 'https://placehold.co/600x400?text=Shop+B',
  phone: '+998900000202',
  address: 'UI test address B',
  location: { type: 'Point', coordinates: [69.25, 41.31] },
  isOperational: true,
  workingHours: [{ days: ALL_DAYS, from: '08:00', to: '22:00' }],
  services: [{ name: { en: 'Classic Haircut', uz: 'Klassik Soch Olish', ru: 'Классическая Стрижка' }, price: 45000, durationMinutes: 30 }],
  staff: [],
});

console.log(JSON.stringify({ shopAId: shopA._id.toString(), shopBId: shopB._id.toString() }));
await mongoose.disconnect();
