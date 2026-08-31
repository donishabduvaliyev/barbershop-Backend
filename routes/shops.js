import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { notifyShopOwnerOfNewBooking } from '../config/shopControlBot.js';
import { requireTelegramAuth } from '../middleware/telegramAuth.js';
import { assertBookableTime, BookingValidationError } from '../utils/bookingTime.js';
import { toDateKey } from '../utils/dateKey.js';

const router = express.Router();

// A flood of requests (a retry-loop bug, or someone mashing the button) can
// spam a shop owner with duplicate Telegram notifications and risks hitting
// Telegram's own per-chat rate limit — so this is capped per Telegram
// account, not per IP (many customers can share one IP through Telegram's
// own infra, and IP is meaningless behind an ngrok tunnel anyway). Runs
// after requireTelegramAuth so req.telegramUser is already verified.
const bookingRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.telegramUser?.id?.toString() || ipKeyGenerator(req.ip),
  message: { message: "You're sending requests too quickly — please wait a few minutes and try again." },
});



router.get('/home-feed', async (req, res) => {
  try {
    const feed = await ServicesModel.aggregate([
      // First, sort all shops by rating to get the best ones at the top
      { $sort: { rating: -1 } },

      // Group the shops by their category
      {
        $group: {
          _id: '$category', // Group by the 'category' field
          shops: { $push: '$$ROOT' } // Push the whole shop document into a 'shops' array
        }
      },

      // Reshape the output to be cleaner
      {
        $project: {
          _id: 0, // Remove the default _id field
          category: '$_id', // Rename _id to 'category'
          shops: { $slice: ['$shops', 10] } // IMPORTANT: Only take the first 5 shops from each category array
        }
      }
    ]);

    res.status(200).json(feed);

  } catch (error) {
    console.error('Error fetching home feed:', error);
    res.status(500).json({ message: 'Server error retrieving home feed' });
  }
});


router.post('/search-shops', async (req, res) => {
  try {
    const {
      name, // New: for searching by shop name
      category,
      priceTiers,
      sortBy,
      editorsChoice,
      userLocation,
      page = 1,
      limit = 10
    } = req.body;

    const matchQuery = { isOperational: true };

    // Add search by name using a case-insensitive regex
    if (name) {
      matchQuery['name.ru'] = { $regex: name, $options: 'i' };
    }
    // ... add other filters like category, priceTiers, etc.
    if (category) matchQuery.category = category;
    if (editorsChoice) matchQuery.isEditorsChoice = true;
    if (priceTiers && priceTiers.length > 0) matchQuery.priceTier = { $in: priceTiers };

    // The rest of the pipeline logic (geoNear, sorting, facet) is the same...
    let pipeline = [];
    if (userLocation && userLocation.coordinates) {
      pipeline.push({
        $geoNear: {
          near: { type: 'Point', coordinates: userLocation.coordinates },
          distanceField: 'distanceInKm',
          distanceMultiplier: 0.001,
          query: matchQuery,
          spherical: true,
        },
      });
    } else {
      pipeline.push({ $match: matchQuery });
    }

    const sortOptions = { isPromoted: -1, promotionRank: 1 };
    switch (sortBy) {
      case 'rating': sortOptions.rating = -1; break;
      case 'distance': if (userLocation) sortOptions.distanceInKm = 1; break;
      case 'reviews': sortOptions.reviewsCount = -1; break;
      default: sortOptions.rating = -1; break;
    }

    const skip = (page - 1) * limit;
    pipeline.push({
      $facet: {
        paginatedResults: [{ $sort: sortOptions }, { $skip: skip }, { $limit: parseInt(limit) }],
        totalCount: [{ $count: 'count' }]
      }
    });

    const results = await ServicesModel.aggregate(pipeline);
    const shops = results[0].paginatedResults;
    const totalCount = results[0].totalCount.length > 0 ? results[0].totalCount[0].count : 0;

    res.status(200).json({
      shops,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / limit),
        totalShops: totalCount,
      },
    });

  } catch (error) {
    console.error('Error searching shops:', error);
    res.status(500).json({ message: 'Server error searching shops' });
  }
});



router.post('/discovery-search', async (req, res) => {
  try {
    const { searchTerm, category, userLocation } = req.body;
    const baseMatch = { isOperational: true };

    if (category) {
      baseMatch.category = category;
    }
    if (searchTerm) {
      baseMatch.$or = [
        { 'name.en': { $regex: searchTerm, $options: 'i' } },
        { 'name.uz': { $regex: searchTerm, $options: 'i' } },
        { 'name.ru': { $regex: searchTerm, $options: 'i' } },
      ];
    }

    const pipeline = [
      { $match: baseMatch },
      {
        $facet: {

          advertisedShops: [
            { $match: { isPromoted: true } },
            { $sort: { promotionRank: 1 } },
            { $limit: 5 },
          ],

          editorsChoiceShops: [
            { $match: { isEditorsChoice: true, isPromoted: { $ne: true } } },
            { $sort: { rating: -1 } },
            { $limit: 10 },
          ],

          topRatedShops: [
            { $match: { isPromoted: { $ne: true } } },
            { $sort: { rating: -1, reviewsCount: -1 } },
            { $limit: 10 },
          ],


          bestPriceShops: [
            { $match: { isPromoted: { $ne: true } } },
            { $sort: { priceTier: 1, rating: -1 } },
            { $limit: 10 },
          ],
        },
      },

      {
        $project: {
          advertisedShops: '$advertisedShops',
          editorsChoiceShops: '$editorsChoiceShops',
          topRatedShops: '$topRatedShops',
          bestPriceShops: '$bestPriceShops',

        },
      },
    ];


    let nearYouShops = [];
    if (userLocation && userLocation.coordinates) {
      nearYouShops = await ServicesModel.aggregate([
        {
          $geoNear: {
            near: {
              type: 'Point',
              coordinates: userLocation.coordinates,
            },
            distanceField: 'distanceInKm',
            distanceMultiplier: 0.001,
            query: { ...baseMatch, isPromoted: { $ne: true } },
            spherical: true,
            limit: 10,
          },
        },
      ]);
    }


    const results = await ServicesModel.aggregate(pipeline);


    const finalResponse = results[0] || {};
    finalResponse.nearYouShops = nearYouShops;

    res.status(200).json(finalResponse);

  } catch (error) {
    console.error('Error fetching discovery data:', error);
    res.status(500).json({ message: 'Server error during discovery search' });
  }
});

// A booking is "active" (occupies a slot) while pending or confirmed —
// rejected/cancelled/completed ones never block anything.
const ACTIVE_STATUSES = ['pending', 'confirmed'];

// Atomically claims one "any available" slot for a staffless (or
// no-staff-requested) booking, the same way the staffId unique index does
// for a specific barber. Tries virtualSlot 0, 1, 2… up to capacity - 1,
// relying on the partial unique index on {shopId, requestedTime,
// virtualSlot} to reject a slot number another concurrent request just
// took — so two requests racing for the last opening can't both succeed,
// unlike a plain "count bookings, then insert" check.
async function claimVirtualSlot(bookingDoc, capacity) {
  for (let slot = 0; slot < capacity; slot++) {
    bookingDoc.virtualSlot = slot;
    try {
      await bookingDoc.save();
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      bookingDoc.isNew = true; // retry the same in-memory doc with the next slot
    }
  }
  return false;
}

router.post('/booking-requests', requireTelegramAuth, bookingRateLimiter, async (req, res) => {
  try {
    const { shopId, shopName, requestedTime, userNumber, userTelegramNumber, userName, staffId, serviceId, lang } = req.body;

    // Trust the Telegram identity verified by requireTelegramAuth, never the
    // client-supplied userTelegramId/username — otherwise anyone could book
    // (or impersonate another user) without ever opening the app in Telegram.
    const userTelegramId = req.telegramUser.id;
    const userTelegramUsername = req.telegramUser.username || '';

    if (!shopId || !requestedTime || !userNumber) {
      return res.status(400).json({ message: 'Missing required information.' });
    }

    const shop = await ServicesModel.findById(shopId).select('staff services workingHours isOperational capacity');
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found.' });
    }
    if (!shop.isOperational) {
      return res.status(409).json({ message: 'This shop is not currently accepting bookings.' });
    }

    const requestedTimeDate = new Date(requestedTime);
    const requestedDateKey = toDateKey(requestedTimeDate);

    // A staffId/serviceId is only ever honored if it actually belongs to
    // this shop — never trust client-supplied name/price alongside it.
    // Resolved before the working-hours check below, since a specific
    // staff member's own hours (if they have any set) take precedence over
    // the shop's blanket hours.
    let resolvedStaffMember = null;
    if (staffId) {
      const staffMember = shop.staff?.id(staffId);
      if (staffMember) {
        if (staffMember.daysOff?.includes(requestedDateKey)) {
          return res.status(400).json({ message: `${staffMember.name} is off that day — please pick another date or barber.` });
        }
        resolvedStaffMember = staffMember;
      }
    }
    const resolvedStaffId = resolvedStaffMember?._id || null;
    const resolvedStaffName = resolvedStaffMember?.name || '';

    const effectiveWorkingHours = resolvedStaffMember?.workingHours?.length
      ? resolvedStaffMember.workingHours
      : shop.workingHours;
    try {
      assertBookableTime(effectiveWorkingHours, requestedTimeDate, resolvedStaffName || 'This shop');
    } catch (err) {
      if (err instanceof BookingValidationError) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }

    // A customer can't be in two places at once — this catches the honest
    // "forgot I already booked" case (and the Rebook shortcut making it
    // easy to do by accident). App-level check is fine here since it's a
    // courtesy guard against the customer's own past bookings, not a
    // shared-resource integrity constraint like the barber/slot ones below.
    const selfConflict = await Booking.exists({
      userTelegramId, requestedTime: requestedTimeDate, status: { $in: ACTIVE_STATUSES },
    });
    if (selfConflict) {
      console.log(`⏭️ Booking blocked (self-conflict) — user ${userTelegramId} @ ${requestedTimeDate.toISOString()}`);
      return res.status(409).json({ message: 'You already have another appointment booked at this time.' });
    }

    // serviceId is optional for now — clients running an older build don't
    // send one yet. When present it must be real; when absent we just skip
    // attaching service/price info instead of failing the whole booking.
    let resolvedService = null;
    if (serviceId) {
      resolvedService = shop.services?.id(serviceId);
      if (!resolvedService) {
        return res.status(400).json({ message: 'Selected service is no longer available.' });
      }
    }

    // A staff member restricted to specific services (serviceIds non-empty)
    // can't be booked for anything outside that list — same "don't just
    // trust the UI filtered it" reasoning as the days-off check above.
    if (resolvedStaffMember && resolvedService && resolvedStaffMember.serviceIds?.length > 0) {
      const performsIt = resolvedStaffMember.serviceIds.some((id) => id.toString() === resolvedService._id.toString());
      if (!performsIt) {
        return res.status(400).json({ message: `${resolvedStaffMember.name} doesn't offer this service — please pick another barber or service.` });
      }
    }

    // Snapshot the name in whichever language the customer was actually
    // using, instead of always defaulting to English regardless of locale —
    // falls back to English only if that language variant is missing.
    const serviceName = resolvedService
      ? (resolvedService.name?.[lang] || resolvedService.name?.en || resolvedService.name?.ru || resolvedService.name?.uz || '')
      : '';

    const baseFields = {
      shopId,
      shopName,
      userTelegramId,
      userTelegramUsername,
      requestedTime: requestedTimeDate,
      userNumber,
      userTelegramNumber,
      userName,
      serviceId: resolvedService?._id || null,
      serviceName,
      price: resolvedService?.price ?? null,
      status: 'pending',
    };

    let newBookingRequest;

    if (resolvedStaffId) {
      // A specific barber was requested — the partial unique index on
      // {shopId, staffId, requestedTime} is what actually prevents two
      // people booking the same barber/slot at once; this save() either
      // succeeds outright or fails with a duplicate-key error we turn into
      // a clean response below.
      newBookingRequest = new Booking({ ...baseFields, staffId: resolvedStaffId, staffName: resolvedStaffName });
      try {
        await newBookingRequest.save();
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).json({ message: 'That barber was just booked for this time — please pick another slot.' });
        }
        throw err;
      }
    } else {
      // "Any available" — capacity is however many staff are named, not off
      // that day, and (if a service was picked) actually perform it — or
      // the shop's plain capacity number for shops that don't track
      // individual staff. claimVirtualSlot races safely against concurrent
      // requests for the same shop/hour via its own unique index.
      const qualifiedStaff = (shop.staff || []).filter((s) => {
        if (s.daysOff?.includes(requestedDateKey)) return false;
        if (resolvedService && s.serviceIds?.length > 0) {
          return s.serviceIds.some((id) => id.toString() === resolvedService._id.toString());
        }
        return true;
      });
      const capacity = shop.staff?.length > 0 ? qualifiedStaff.length : (shop.capacity || 1);
      if (capacity === 0) {
        console.log(`⏭️ Booking blocked (no qualified staff) — shop ${shopId} @ ${requestedTimeDate.toISOString()}`);
        return res.status(409).json({ message: 'No staff can perform this on that date — please pick another date or service.' });
      }
      newBookingRequest = new Booking({ ...baseFields, staffId: null, staffName: '' });
      const claimed = await claimVirtualSlot(newBookingRequest, capacity);
      if (!claimed) {
        console.log(`⏭️ Booking blocked (fully booked) — shop ${shopId} @ ${requestedTimeDate.toISOString()}`);
        return res.status(409).json({ message: 'This time slot is fully booked — please pick another.' });
      }
    }

    console.log(`📥 New booking ${newBookingRequest._id} — ${shopName}, ${userName} @ ${requestedTimeDate.toISOString()}${resolvedStaffName ? ` with ${resolvedStaffName}` : ''}${serviceName ? ` (${serviceName})` : ''}`);

    // The booking is already saved at this point — a failure to notify the
    // shop owner shouldn't make the client think their request wasn't received.
    try {
      await notifyShopOwnerOfNewBooking(newBookingRequest);
    } catch (notifyError) {
      console.error('Failed to notify shop owner of new booking:', notifyError);
    }

    res.status(201).json({
      message: 'Your booking request has been sent! You will receive a confirmation on Telegram.'
    });

  } catch (error) {
    console.error('Error creating booking request:', error);
    res.status(500).json({ message: 'Server error while creating booking request.' });
  }
});

router.get('/service/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'Shop ID is required.' });
    }
    const shop = await ServicesModel.findById(id).select('workingHours staff capacity');
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found.' });
    }

    // Pending bookings block a slot too now, not just confirmed ones —
    // otherwise two customers can both see (and request) the same barber's
    // slot while the shop owner hasn't responded to the first one yet.
    // Capped to the next 60 days so this payload doesn't grow unbounded as
    // a shop accumulates far-future bookings over time.
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 60);
    const activeBookings = await Booking.find({
      shopId: id,
      status: { $in: ACTIVE_STATUSES },
      requestedTime: { $gte: new Date(), $lte: horizon },
    }).select('requestedTime staffId');

    // staffId travels with each slot so the customer app can tell "this
    // barber is taken" apart from "a different barber is taken" at the same
    // hour, instead of blocking the whole shop for one barber's booking.
    const bookedSlots = activeBookings.map((b) => ({
      requestedTime: b.requestedTime.toISOString(),
      staffId: b.staffId ? b.staffId.toString() : null,
    }));

    res.status(200).json({
      workingHours: shop.workingHours,
      staffCount: shop.staff?.length || 0,
      // Only meaningful when staffCount is 0 — "how many clients can this
      // staffless shop serve at the same hour" (see models/shopData.js).
      capacity: shop.capacity || 1,
      bookedSlots,
    });

  } catch (error) {
    console.error('Error fetching shop availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/shops/:id', async (req, res) => {
  try {
    const shop = await ServicesModel.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Shop not found' });
    res.status(200).json(shop);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/allShops', async (req, res) => {
  try {
    const shops = await ServicesModel.find({});
    res.status(200).json(shops);
  } catch (error) {
    console.error('Error fetching shops:', error);
    res.status(500).json({ message: 'Server error fetching shops' });
  }
})


export default router;
