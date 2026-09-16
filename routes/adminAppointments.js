import express from 'express';
import Booking from '../models/bookingHistory.js';
import ServicesModel from '../models/shopData.js';
import { requireShopAdmin } from '../middleware/adminAuth.js';
import { confirmBooking, rejectBooking, completeBooking, markNoShow, cancelBooking, rescheduleBooking } from '../services/bookingActions.js';
import { createBooking, BookingConflictError, BookingNotFoundError } from '../services/createBooking.js';
import { BookingValidationError } from '../utils/bookingTime.js';
import { generateSyntheticTelegramId } from '../utils/syntheticCustomerId.js';
import Customer from '../models/customer.js';

const router = express.Router();
router.use(requireShopAdmin);

function mapBookingError(error, res) {
  if (error instanceof BookingValidationError) return res.status(400).json({ message: error.message });
  if (error instanceof BookingConflictError) return res.status(409).json({ message: error.message });
  if (error instanceof BookingNotFoundError) return res.status(404).json({ message: error.message });
  return null;
}

// List + filter + paginate every appointment for this shop — pending,
// upcoming confirmed, and full historical (completed/rejected/cancelled).
router.get('/', async (req, res) => {
  try {
    const { status, staffId, from, to, page = 1, limit = 20 } = req.query;
    const query = { shopId: req.shopId };

    if (status) query.status = status;
    if (staffId) query.staffId = staffId;
    if (from || to) {
      query.requestedTime = {};
      if (from) query.requestedTime.$gte = new Date(from);
      if (to) query.requestedTime.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [appointments, totalCount] = await Promise.all([
      Booking.find(query).sort({ requestedTime: -1 }).skip(skip).limit(Number(limit)),
      Booking.countDocuments(query),
    ]);

    res.status(200).json({
      appointments,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)) || 1,
        totalCount,
      },
    });
  } catch (error) {
    console.error('Error listing admin appointments:', error);
    res.status(500).json({ message: 'Server error fetching appointments.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!booking) return res.status(404).json({ message: 'Appointment not found.' });
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error fetching admin appointment:', error);
    res.status(500).json({ message: 'Server error fetching appointment.' });
  }
});

// Manual booking — walk-ins and phone calls, entered by the owner instead
// of coming through the customer app. Reuses the exact same
// staff/service/working-hours/capacity rules as a customer-app booking
// (services/createBooking.js) so the two entry points can never drift.
//
// Body carries either `telegramId` (an existing customer — real or a
// synthetic negative id from a previous walk-in) or `{name, number}` for a
// brand-new walk-in, which gets a fresh synthetic id and a real Customer
// record created up front (rather than waiting for createBooking's
// best-effort upsert) so it exists even if booking creation itself fails
// validation and the owner just wants the client on file either way.
router.post('/', async (req, res) => {
  try {
    const { telegramId, name, number, serviceId, staffId, requestedTime, source, note } = req.body;

    if (!requestedTime) {
      return res.status(400).json({ message: 'requestedTime is required.' });
    }
    if (!['phone', 'walk-in'].includes(source)) {
      return res.status(400).json({ message: "source must be 'phone' or 'walk-in'." });
    }

    let userTelegramId = telegramId ? Number(telegramId) : null;
    let userName = name;
    let userNumber = number;

    if (!userTelegramId) {
      if (!name || !number) {
        return res.status(400).json({ message: 'Either an existing telegramId or a new client\'s name and number is required.' });
      }
      // Reuse an existing record for an exact name+number match rather than
      // minting a new synthetic id every time — otherwise retrying after a
      // validation error (e.g. an invalid time) with the same "new client"
      // fields creates a duplicate Customer for the same real person each
      // attempt, since the Customer is created here regardless of whether
      // the booking itself goes on to succeed.
      const existingByNameNumber = await Customer.findOne({ shopId: req.shopId, name, number });
      if (existingByNameNumber) {
        userTelegramId = existingByNameNumber.telegramId;
      } else {
        userTelegramId = generateSyntheticTelegramId();
        await Customer.create({ shopId: req.shopId, telegramId: userTelegramId, name, number });
      }
    } else {
      const existing = await Customer.findOne({ shopId: req.shopId, telegramId: userTelegramId });
      if (existing) {
        userName = existing.name;
        userNumber = existing.number;
      } else {
        // A legacy customer that only exists via the booking aggregate
        // (never upgraded to a real Customer doc) — fall back to their
        // most recent booking's snapshot so the new booking still has a
        // name/number without requiring the owner to retype them.
        const lastBooking = await Booking.findOne({ shopId: req.shopId, userTelegramId }).sort({ requestedTime: -1 });
        if (!lastBooking) {
          return res.status(404).json({ message: 'That customer has no prior history — add their name and number instead.' });
        }
        userName = lastBooking.userName;
        userNumber = lastBooking.userNumber;
      }
    }

    const shop = await ServicesModel.findById(req.shopId).select('name');
    const booking = await createBooking({
      shopId: req.shopId,
      shopName: shop?.name?.en || '',
      requestedTime,
      staffId: staffId || null,
      serviceId: serviceId || null,
      userTelegramId,
      userNumber,
      userName,
      source,
      checkShopOperational: false,
    });

    if (note) {
      booking.adminNotes = note;
      await booking.save();
    }

    res.status(201).json(booking);
  } catch (error) {
    if (mapBookingError(error, res)) return;
    console.error('Error creating manual appointment:', error);
    res.status(500).json({ message: 'Server error creating appointment.' });
  }
});

// Free-text note about the booking itself (what the customer asked for,
// special instructions) — distinct from a customer's general CRM notes
// (routes/adminCustomers.js), which persist across all of their visits.
router.patch('/:id/notes', async (req, res) => {
  try {
    const { note } = req.body;
    const booking = await Booking.findOneAndUpdate(
      { _id: req.params.id, shopId: req.shopId },
      { $set: { adminNotes: note || '' } },
      { new: true }
    );
    if (!booking) return res.status(404).json({ message: 'Appointment not found.' });
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error updating appointment note:', error);
    res.status(500).json({ message: 'Server error updating note.' });
  }
});

// Confirm/reject/complete reuse the exact same logic the shop-control bot's
// buttons call, so a Telegram message and a panel click stay consistent.
router.patch('/:id/confirm', async (req, res) => {
  try {
    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await confirmBooking(req.params.id);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error confirming appointment:', error);
    res.status(500).json({ message: 'Server error confirming appointment.' });
  }
});

router.patch('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'A rejection reason is required.' });

    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await rejectBooking(req.params.id, reason);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error rejecting appointment:', error);
    res.status(500).json({ message: 'Server error rejecting appointment.' });
  }
});

router.patch('/:id/complete', async (req, res) => {
  try {
    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await completeBooking(req.params.id);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error completing appointment:', error);
    res.status(500).json({ message: 'Server error completing appointment.' });
  }
});

router.patch('/:id/no-show', async (req, res) => {
  try {
    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await markNoShow(req.params.id);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error marking appointment no-show:', error);
    res.status(500).json({ message: 'Server error marking appointment no-show.' });
  }
});

// Distinct from /reject: reject is for the pending stage, cancel is the
// owner calling off something already confirmed. Reason is optional.
router.patch('/:id/cancel', async (req, res) => {
  try {
    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await cancelBooking(req.params.id, req.body?.reason);
    res.status(200).json(booking);
  } catch (error) {
    console.error('Error cancelling appointment:', error);
    res.status(500).json({ message: 'Server error cancelling appointment.' });
  }
});

// Moves an existing booking to a new time — same customer/staff/service,
// reruns the same availability rules a fresh booking would for that time.
router.patch('/:id/reschedule', async (req, res) => {
  try {
    const { requestedTime } = req.body;
    if (!requestedTime) return res.status(400).json({ message: 'requestedTime is required.' });

    const owned = await Booking.exists({ _id: req.params.id, shopId: req.shopId });
    if (!owned) return res.status(404).json({ message: 'Appointment not found.' });

    const booking = await rescheduleBooking(req.params.id, new Date(requestedTime));
    res.status(200).json(booking);
  } catch (error) {
    if (mapBookingError(error, res)) return;
    console.error('Error rescheduling appointment:', error);
    res.status(500).json({ message: 'Server error rescheduling appointment.' });
  }
});

export default router;
