import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { notifyShopOwnerOfNewBooking } from '../config/shopControlBot.js';
import { requireTelegramAuth } from '../middleware/telegramAuth.js';
import { isWithinWorkingHours, BookingValidationError } from '../utils/bookingTime.js';
import { normalizeLanguage } from '../utils/botMessages.js';
import { toDateKey } from '../utils/dateKey.js';
import { createBooking, BookingConflictError, BookingNotFoundError } from '../services/createBooking.js';
import { emitToShop } from '../config/socket.js';

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
      // Soft-deleted shops (routes/superAdmin.js's DELETE /shops/:id) must
      // never reach customers, however this feed is otherwise filtered.
      { $match: { isArchived: { $ne: true } } },
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
    const baseMatch = { isOperational: true, isArchived: { $ne: true } };

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

    const userLanguage = normalizeLanguage(lang);

    // Only backfills — an explicit /language choice in the customer bot
    // always wins over whatever the web app happened to send, so this never
    // overwrites a language the customer already picked on purpose.
    if (lang) {
      User.updateOne(
        { telegramId: String(userTelegramId), language: null },
        { $set: { language: userLanguage } }
      ).catch((err) => console.error('Failed to backfill user language:', err));
    }

    const newBookingRequest = await createBooking({
      shopId, shopName, requestedTime, staffId, serviceId,
      userTelegramId, userTelegramUsername, userNumber, userTelegramNumber, userName,
      userLanguage, source: 'bot',
    });

    console.log(`📥 New booking ${newBookingRequest._id} — ${shopName}, ${userName} @ ${new Date(requestedTime).toISOString()}${newBookingRequest.staffName ? ` with ${newBookingRequest.staffName}` : ''}${newBookingRequest.serviceName ? ` (${newBookingRequest.serviceName})` : ''}`);

    emitToShop(shopId, 'appointment:update', newBookingRequest);

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
    if (error instanceof BookingValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof BookingConflictError) {
      return res.status(409).json({ message: error.message });
    }
    if (error instanceof BookingNotFoundError) {
      return res.status(404).json({ message: error.message });
    }
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

// Regex metacharacters in free-text user input (e.g. "haircut (kids)")
// would otherwise either throw on an invalid pattern or match in
// unintended ways — the existing name-search endpoints above don't escape
// this, but new code shouldn't repeat that gap.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cross-shop "find available now" search: given a free-text service query
// and a desired hour, returns every operational shop that (a) has at least
// one service matching the query and (b) has open capacity for that
// service at that exact hour — so a customer who just wants "a haircut,
// today at 8pm, any shop" doesn't have to check shops one by one. This
// mirrors the single-shop "any available" resolution already used by
// POST /booking-requests and GET /service/:id/availability (shop-level
// workingHours, staff qualified by day-off + serviceIds, capacity =
// qualified-staff count when the shop has staff else shop.capacity), just
// evaluated read-only across many shops instead of one.
router.post('/available-now', async (req, res) => {
  try {
    const { serviceQuery, requestedTime } = req.body || {};

    const query = typeof serviceQuery === 'string' ? serviceQuery.trim().slice(0, 60) : '';
    if (!query) {
      return res.status(400).json({ message: 'Please enter what service you need.' });
    }

    const requestedTimeDate = new Date(requestedTime);
    if (Number.isNaN(requestedTimeDate.getTime())) {
      return res.status(400).json({ message: 'Invalid requested time.' });
    }
    if (requestedTimeDate.getTime() <= Date.now()) {
      return res.status(400).json({ message: 'Please pick a time in the future.' });
    }

    const regex = new RegExp(escapeRegex(query), 'i');
    const dateKey = toDateKey(requestedTimeDate);

    const candidateShops = await ServicesModel.find({
      isOperational: true,
      isArchived: { $ne: true },
      $or: [
        { 'services.name.en': regex },
        { 'services.name.uz': regex },
        { 'services.name.ru': regex },
      ],
    })
      .select('name category image rating reviewsCount address services staff workingHours capacity')
      .limit(200);

    const shopIds = candidateShops.map((s) => s._id);
    const bookedCounts = await Booking.aggregate([
      { $match: { shopId: { $in: shopIds }, requestedTime: requestedTimeDate, status: { $in: ACTIVE_STATUSES } } },
      { $group: { _id: '$shopId', count: { $sum: 1 } } },
    ]);
    const bookedCountByShopId = new Map(bookedCounts.map((b) => [String(b._id), b.count]));

    const results = [];
    for (const shop of candidateShops) {
      if (!isWithinWorkingHours(shop.workingHours, requestedTimeDate)) continue;

      const matchingServices = shop.services.filter(
        (s) => regex.test(s.name?.en) || regex.test(s.name?.uz) || regex.test(s.name?.ru)
      );
      if (matchingServices.length === 0) continue;

      const bookedCount = bookedCountByShopId.get(String(shop._id)) || 0;

      const matchedServices = matchingServices.filter((service) => {
        const qualifiedStaff = (shop.staff || []).filter(
          (m) => !m.daysOff?.includes(dateKey) && (!m.serviceIds?.length || m.serviceIds.includes(service._id))
        );
        const capacity = shop.staff?.length ? qualifiedStaff.length : (shop.capacity || 1);
        return capacity > 0 && bookedCount < capacity;
      });

      if (matchedServices.length === 0) continue;

      results.push({
        shopId: shop._id,
        name: shop.name,
        image: shop.image,
        category: shop.category,
        rating: shop.rating,
        reviewsCount: shop.reviewsCount,
        address: shop.address,
        matchedServices: matchedServices.map((s) => ({
          serviceId: s._id,
          name: s.name,
          price: s.price,
          durationMinutes: s.durationMinutes,
        })),
      });
    }

    results.sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.status(200).json({ requestedTime: requestedTimeDate.toISOString(), results });
  } catch (error) {
    console.error('Error running available-now search:', error);
    res.status(500).json({ message: 'Server error while searching for availability.' });
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
    const shops = await ServicesModel.find({ isArchived: { $ne: true } });
    res.status(200).json(shops);
  } catch (error) {
    console.error('Error fetching shops:', error);
    res.status(500).json({ message: 'Server error fetching shops' });
  }
})


export default router;
