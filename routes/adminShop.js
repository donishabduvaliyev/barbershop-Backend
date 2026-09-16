import express from 'express';
import multer from 'multer';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { uploadImage, deleteImageByUrl } from '../config/r2.js';
import { rejectBooking } from '../services/bookingActions.js';
import { dateKeyToRange, toDateKey } from '../utils/dateKey.js';

const router = express.Router();
router.use(requireShopAdmin);

const ACTIVE_STATUSES = ['pending', 'confirmed'];

// Files land in memory (not disk) — they're immediately resized/re-encoded
// and streamed to R2, so there's never a reason to touch the filesystem.
// 8MB comfortably covers an unedited phone photo; fileFilter rejects
// anything that isn't actually an image before it's ever processed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  },
});

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
  'isOperational', 'priceTier', 'capacity', 'winBackEnabled',
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

// ---- Photos ----
// Only the resulting R2 URL is ever stored on the document — the image
// bytes themselves never touch MongoDB.

router.post('/photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No photo uploaded.' });

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const { url } = await uploadImage(req.file.buffer, { folder: `shops/${req.shopId}`, maxWidth: 1200 });
    const previousUrl = shop.image;
    shop.image = url;
    await shop.save();
    deleteImageByUrl(previousUrl).catch(() => {}); // best-effort, never blocks the response

    res.status(200).json({ image: shop.image });
  } catch (error) {
    console.error('Error uploading shop photo:', error);
    res.status(500).json({ message: error.message?.includes('image') ? error.message : 'Server error uploading photo.' });
  }
});

router.post('/photos', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No photo uploaded.' });

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const { url } = await uploadImage(req.file.buffer, { folder: `shops/${req.shopId}`, maxWidth: 1200 });
    shop.images.push(url);
    await shop.save();

    res.status(201).json({ images: shop.images });
  } catch (error) {
    console.error('Error uploading gallery photo:', error);
    res.status(500).json({ message: error.message?.includes('image') ? error.message : 'Server error uploading photo.' });
  }
});

router.delete('/photos', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: 'url is required.' });

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    shop.images = shop.images.filter((img) => img !== url);
    await shop.save();
    deleteImageByUrl(url).catch(() => {});

    res.status(200).json({ images: shop.images });
  } catch (error) {
    console.error('Error deleting gallery photo:', error);
    res.status(500).json({ message: 'Server error deleting photo.' });
  }
});

router.post('/staff/:staffId/photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No photo uploaded.' });

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const staffMember = shop.staff.id(req.params.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found.' });

    // Smaller than shop photos — these only ever render as small avatars.
    const { url } = await uploadImage(req.file.buffer, { folder: `staff/${req.shopId}`, maxWidth: 500 });
    const previousUrl = staffMember.photo;
    staffMember.photo = url;
    await shop.save();
    deleteImageByUrl(previousUrl).catch(() => {});

    res.status(200).json({ photo: staffMember.photo });
  } catch (error) {
    console.error('Error uploading staff photo:', error);
    res.status(500).json({ message: error.message?.includes('image') ? error.message : 'Server error uploading photo.' });
  }
});

// ---- Staff days off ----
// Scheduling a day off is enforced server-side in routes/shops.js's booking
// validation too — this isn't just a UI hint, a direct API call can't book
// a staff member on a day marked off here.

router.post('/staff/:staffId/days-off', async (req, res) => {
  try {
    const { date } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ message: 'date must be in YYYY-MM-DD format.' });
    }

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const staffMember = shop.staff.id(req.params.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found.' });

    if (staffMember.daysOff.includes(date)) {
      return res.status(200).json({ daysOff: staffMember.daysOff });
    }

    // Adding a day off after bookings already exist for that day is exactly
    // the conflict the owner asked us to guard against — surface it instead
    // of silently creating a no-show, and only proceed past it (rejecting
    // those bookings with a clear reason) once explicitly confirmed.
    const { start, end } = dateKeyToRange(date);
    const conflicts = await Booking.find({
      shopId: req.shopId,
      staffId: staffMember._id,
      status: { $in: ACTIVE_STATUSES },
      requestedTime: { $gte: start, $lt: end },
    }).select('_id userName requestedTime');

    if (conflicts.length > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        message: `${staffMember.name} already has ${conflicts.length} appointment${conflicts.length === 1 ? '' : 's'} booked that day.`,
        conflicts: conflicts.map((b) => ({ id: b._id, userName: b.userName, requestedTime: b.requestedTime })),
      });
    }

    staffMember.daysOff.push(date);
    await shop.save();

    for (const conflict of conflicts) {
      await rejectBooking(conflict._id, `${staffMember.name} is off that day — please rebook for another date.`);
    }

    res.status(200).json({ daysOff: staffMember.daysOff, rejectedCount: conflicts.length });
  } catch (error) {
    console.error('Error adding day off:', error);
    res.status(500).json({ message: 'Server error adding day off.' });
  }
});

router.delete('/staff/:staffId/days-off', async (req, res) => {
  try {
    const { date } = req.body;
    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const staffMember = shop.staff.id(req.params.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found.' });

    staffMember.daysOff = staffMember.daysOff.filter((d) => d !== date);
    await shop.save();

    res.status(200).json({ daysOff: staffMember.daysOff });
  } catch (error) {
    console.error('Error removing day off:', error);
    res.status(500).json({ message: 'Server error removing day off.' });
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

    const { name, price, durationMinutes, isActive } = req.body;
    if (name !== undefined) service.name = name;
    if (price !== undefined) service.price = price;
    if (durationMinutes !== undefined) service.durationMinutes = durationMinutes;
    if (isActive !== undefined) service.isActive = isActive;

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

    const { name, title, photo, serviceIds, commission, workingHours } = req.body;
    if (name !== undefined) staffMember.name = name;
    if (title !== undefined) staffMember.title = title;
    if (photo !== undefined) staffMember.photo = photo;
    if (serviceIds !== undefined) staffMember.serviceIds = serviceIds;
    if (commission !== undefined) staffMember.commission = commission;
    if (workingHours !== undefined) staffMember.workingHours = workingHours;

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

// One-tap "called in sick / stepped out" toggle — deliberately separate
// from the full staff-edit PATCH above (which is a form submission), and
// from daysOff (a pre-scheduled whole day off) and workingHours (the
// recurring weekly schedule). See models/shopData.js's isAvailableNow.
router.patch('/staff/:staffId/availability', async (req, res) => {
  try {
    const { isAvailableNow } = req.body;
    if (typeof isAvailableNow !== 'boolean') {
      return res.status(400).json({ message: 'isAvailableNow (boolean) is required.' });
    }

    const shop = await ServicesModel.findById(req.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const staffMember = shop.staff.id(req.params.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found.' });

    staffMember.isAvailableNow = isAvailableNow;
    await shop.save();
    res.status(200).json(shop.staff);
  } catch (error) {
    console.error('Error updating staff availability:', error);
    res.status(500).json({ message: 'Server error updating staff availability.' });
  }
});

// ---- Calendar / day schedule ----

// One day, every staff member, every booking — no existing endpoint answers
// this today (routes/shops.js's endpoints all answer "is hour X open for
// staff Y or any-available", not "show the whole day's grid at once"). The
// admin calendar page renders this directly: a staff column per staff
// member (or a single pooled column for staffless shops) and an hour row
// per shop-hour, using `bookings` to mark cells busy and `daysOff`/
// `isAvailableNow` to mark a whole column (or just today) unavailable.
router.get('/schedule', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date (YYYY-MM-DD) is required.' });
    }

    const shop = await ServicesModel.findById(req.shopId).select('staff workingHours capacity');
    if (!shop) return res.status(404).json({ message: 'Shop not found.' });

    const { start, end } = dateKeyToRange(date);
    const bookings = await Booking.find({
      shopId: req.shopId,
      requestedTime: { $gte: start, $lt: end },
      status: { $in: [...ACTIVE_STATUSES, 'completed', 'no-show'] },
    }).sort({ requestedTime: 1 });

    const isToday = date === toDateKey(new Date());
    const bookingSummary = (b) => ({
      id: b._id, hour: b.requestedTime.getHours(), status: b.status, source: b.source,
      userName: b.userName, userNumber: b.userNumber, serviceName: b.serviceName,
    });

    const staff = (shop.staff || []).map((member) => ({
      id: member._id,
      name: member.name,
      photo: member.photo,
      isAvailableNow: member.isAvailableNow !== false,
      isOffToday: member.daysOff?.includes(date) || false,
      // null means "follows the shop's blanket hours" — the frontend
      // resolves the same fallback the booking logic itself uses.
      workingHours: member.workingHours?.length ? member.workingHours : null,
      bookings: bookings.filter((b) => b.staffId && String(b.staffId) === String(member._id)).map(bookingSummary),
    }));

    // "Any available" bookings (staffId: null) aren't pinned to a specific
    // staff column — shown separately so the grid doesn't have to guess
    // which staff member will actually take them.
    const unassignedBookings = bookings.filter((b) => !b.staffId).map(bookingSummary);

    res.status(200).json({
      date,
      isToday,
      workingHours: shop.workingHours,
      capacity: shop.capacity || 1,
      staff,
      unassignedBookings,
    });
  } catch (error) {
    console.error('Error building admin schedule:', error);
    res.status(500).json({ message: 'Server error building schedule.' });
  }
});

export default router;
