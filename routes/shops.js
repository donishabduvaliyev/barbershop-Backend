import express from 'express';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { notifyShopOwnerOfNewBooking } from '../config/shopControlBot.js';
import { requireTelegramAuth } from '../middleware/telegramAuth.js';
import { assertBookableTime, BookingValidationError } from '../utils/bookingTime.js';

const router = express.Router();



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

router.post('/booking-requests', requireTelegramAuth, async (req, res) => {
  try {
    const { shopId, shopName, requestedTime, userNumber, userTelegramNumber, userName, staffId, serviceId } = req.body;

    // Trust the Telegram identity verified by requireTelegramAuth, never the
    // client-supplied userTelegramId/username — otherwise anyone could book
    // (or impersonate another user) without ever opening the app in Telegram.
    const userTelegramId = req.telegramUser.id;
    const userTelegramUsername = req.telegramUser.username || '';

    if (!shopId || !requestedTime || !userNumber) {
      return res.status(400).json({ message: 'Missing required information.' });
    }

    const shop = await ServicesModel.findById(shopId).select('staff services workingHours isOperational');
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found.' });
    }
    if (!shop.isOperational) {
      return res.status(409).json({ message: 'This shop is not currently accepting bookings.' });
    }

    const requestedTimeDate = new Date(requestedTime);
    try {
      assertBookableTime(shop, requestedTimeDate);
    } catch (err) {
      if (err instanceof BookingValidationError) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }

    // A staffId/serviceId is only ever honored if it actually belongs to
    // this shop — never trust client-supplied name/price alongside it.
    let resolvedStaffId = null;
    let resolvedStaffName = '';
    if (staffId) {
      const staffMember = shop.staff?.id(staffId);
      if (staffMember) {
        resolvedStaffId = staffMember._id;
        resolvedStaffName = staffMember.name;
      }
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

    // "Any available" (no specific staff requested) has no DB-level
    // uniqueness constraint to lean on — a specific staff pick does (see the
    // partial unique index on the model) — so check capacity ourselves: a
    // staffless shop has one shared slot per hour; a staffed shop is full
    // once every staff member already has an active booking that hour.
    if (!resolvedStaffId) {
      if (!shop.staff || shop.staff.length === 0) {
        const taken = await Booking.exists({
          shopId, requestedTime: requestedTimeDate, status: { $in: ACTIVE_STATUSES },
        });
        if (taken) {
          return res.status(409).json({ message: 'This time slot was just taken — please pick another.' });
        }
      } else {
        const bookedStaffIds = await Booking.distinct('staffId', {
          shopId, requestedTime: requestedTimeDate, status: { $in: ACTIVE_STATUSES }, staffId: { $ne: null },
        });
        if (bookedStaffIds.length >= shop.staff.length) {
          return res.status(409).json({ message: 'This time slot is fully booked — please pick another.' });
        }
      }
    }

    const newBookingRequest = new Booking({
      shopId,
      shopName,
      userTelegramId,
      userTelegramUsername,
      requestedTime: requestedTimeDate,
      userNumber,
      userTelegramNumber,
      userName,
      staffId: resolvedStaffId,
      staffName: resolvedStaffName,
      serviceId: resolvedService?._id || null,
      serviceName: resolvedService ? (resolvedService.name?.en || resolvedService.name?.ru || resolvedService.name?.uz || '') : '',
      price: resolvedService?.price ?? null,
      status: 'pending',
    });

    try {
      await newBookingRequest.save();
    } catch (err) {
      // Race-condition backstop: two requests for the same barber/slot can
      // both pass the checks above in the same instant — the partial unique
      // index on the model is what actually prevents the double-booking;
      // this just turns that into a clean response instead of a 500.
      if (err.code === 11000) {
        return res.status(409).json({ message: 'That barber was just booked for this time — please pick another slot.' });
      }
      throw err;
    }

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
    const shop = await ServicesModel.findById(id).select('workingHours staff');
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
