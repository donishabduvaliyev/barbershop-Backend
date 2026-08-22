import express from 'express';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';

const router = express.Router();
router.use(requireShopAdmin);

const ACTIVE_STATUSES = ['pending', 'confirmed'];

// How many upcoming active bookings reference this staff/service — used to
// warn before a delete rather than silently orphaning appointments that
// still need to happen.
async function countUpcomingBookings(shopId, field, id) {
  return Booking.countDocuments({
    shopId,
    [field]: id,
    status: { $in: ACTIVE_STATUSES },
    requestedTime: { $gte: new Date() },
  });
}

// Every handler below trusts only req.shopId (from the verified JWT) to
// decide which shop it's touching — never a client-supplied shop id.

router.get('/', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });
    res.status(200).json(shop);
  } catch (error) {
    console.error('Error fetching admin shop:', error);
    res.status(500).json({ message: 'Server error fetching shop.' });
  }
});

const EDITABLE_SHOP_FIELDS = [
  'name', 'description', 'phone', 'address', 'location', 'image', 'images',
  'isOperational', 'priceTier',
];

router.patch('/', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    for (const field of EDITABLE_SHOP_FIELDS) {
      if (field in req.body) shop[field] = req.body[field];
    }
    await shop.save();
    res.status(200).json(shop);
  } catch (error) {
    console.error('Error updating admin shop:', error);
    res.status(500).json({ message: 'Server error updating shop.' });
  }
});

router.patch('/working-hours', async (req, res) => {
  try {
    const { workingHours } = req.body;
    if (!Array.isArray(workingHours)) {
      return res.status(400).json({ message: 'workingHours must be an array.' });
    }
    const shop = await ServicesModel.findByIdAndUpdate(
      req.shopId,
      { $set: { workingHours } },
      { new: true, runValidators: true }
    );
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });
    res.status(200).json(shop.workingHours);
  } catch (error) {
    console.error('Error updating working hours:', error);
    res.status(500).json({ message: 'Server error updating working hours.' });
  }
});

// ---- Services ----

router.post('/services', async (req, res) => {
  try {
    const { name, price, durationMinutes } = req.body;
    if (!name || price == null || durationMinutes == null) {
      return res.status(400).json({ message: 'name, price and durationMinutes are required.' });
    }
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    shop.services.push({ name, price, durationMinutes });
    await shop.save();
    res.status(201).json(shop.services);
  } catch (error) {
    console.error('Error adding service:', error);
    res.status(500).json({ message: 'Server error adding service.' });
  }
});

router.patch('/services/:serviceId', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const service = shop.services.id(req.params.serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found.' });

    const { name, price, durationMinutes } = req.body;
    if (name !== undefined) service.name = name;
    if (price !== undefined) service.price = price;
    if (durationMinutes !== undefined) service.durationMinutes = durationMinutes;

    await shop.save();
    res.status(200).json(shop.services);
  } catch (error) {
    console.error('Error updating service:', error);
    res.status(500).json({ message: 'Server error updating service.' });
  }
});

router.delete('/services/:serviceId', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const service = shop.services.id(req.params.serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found.' });

    if (req.query.force !== 'true') {
      const upcomingCount = await countUpcomingBookings(req.shopId, 'serviceId', service._id);
      if (upcomingCount > 0) {
        return res.status(409).json({
          message: `This service has ${upcomingCount} upcoming appointment${upcomingCount === 1 ? '' : 's'}.`,
          upcomingCount,
        });
      }
    }

    service.deleteOne();
    await shop.save();
    res.status(200).json(shop.services);
  } catch (error) {
    console.error('Error deleting service:', error);
    res.status(500).json({ message: 'Server error deleting service.' });
  }
});

// ---- Staff ----

router.post('/staff', async (req, res) => {
  try {
    const { name, title, photo } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required.' });

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    shop.staff.push({ name, title: title || '', photo: photo || '' });
    await shop.save();
    res.status(201).json(shop.staff);
  } catch (error) {
    console.error('Error adding staff member:', error);
    res.status(500).json({ message: 'Server error adding staff member.' });
  }
});

router.patch('/staff/:staffId', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const staffMember = shop.staff.id(req.params.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found.' });

    const { name, title, photo } = req.body;
    if (name !== undefined) staffMember.name = name;
    if (title !== undefined) staffMember.title = title;
    if (photo !== undefined) staffMember.photo = photo;

    await shop.save();
    res.status(200).json(shop.staff);
  } catch (error) {
    console.error('Error updating staff member:', error);
    res.status(500).json({ message: 'Server error updating staff member.' });
  }
});

router.delete('/staff/:staffId', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const staffMember = shop.staff.id(req.params.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found.' });

    if (req.query.force !== 'true') {
      const upcomingCount = await countUpcomingBookings(req.shopId, 'staffId', staffMember._id);
      if (upcomingCount > 0) {
        return res.status(409).json({
          message: `${staffMember.name} has ${upcomingCount} upcoming appointment${upcomingCount === 1 ? '' : 's'}.`,
          upcomingCount,
        });
      }
    }

    staffMember.deleteOne();
    await shop.save();
    res.status(200).json(shop.staff);
  } catch (error) {
    console.error('Error deleting staff member:', error);
    res.status(500).json({ message: 'Server error deleting staff member.' });
  }
});

export default router;
