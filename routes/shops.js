import express from 'express';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { notifyShopOwnerOfNewBooking } from '../config/shopControlBot.js';
import { requireTelegramAuth } from '../middleware/telegramAuth.js';

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

router.post('/booking-requests', requireTelegramAuth, async (req, res) => {
  try {
    const { shopId, shopName, requestedTime, userNumber, userTelegramNumber, userName, staffId, serviceId } = req.body;

    // Trust the Telegram identity verified by requireTelegramAuth, never the
    // client-supplied userTelegramId/username — otherwise anyone could book
    // (or impersonate another user) without ever opening the app in Telegram.
    const userTelegramId = req.telegramUser.id;
    const userTelegramUsername = req.telegramUser.username || '';

    if (!shopId || !requestedTime || !userNumber ) {
      return res.status(400).json({ message: 'Missing required information.' });
    }

    // A staffId/serviceId is only ever honored if it actually belongs to
    // this shop — never trust client-supplied name/price alongside it.
    const shop = await ServicesModel.findById(shopId).select('staff services');

    let resolvedStaffId = null;
    let resolvedStaffName = '';
    if (staffId) {
      const staffMember = shop?.staff?.id(staffId);
      if (staffMember) {
        resolvedStaffId = staffMember._id;
        resolvedStaffName = staffMember.name;
      }
    }

   // serviceId is optional for now — clients running the old build don't send
// one yet. When present it must be real; when absent we just skip
// attaching service/price info instead of failing the whole booking.
let resolvedService = null;
if (serviceId) {
  resolvedService = shop?.services?.id(serviceId);
  if (!resolvedService) {
    return res.status(400).json({ message: 'Selected service is no longer available.' });
  }
}

const newBookingRequest = new Booking({
  shopId,
  shopName,
  userTelegramId,
  userTelegramUsername,
  requestedTime,
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

    await newBookingRequest.save();

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
    const shop = await ServicesModel.findById(id).select('workingHours');
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found.' });
    }
    const confirmedBookings = await Booking.find({
      shopId: id,
      status: 'confirmed',
      requestedTime: { $gte: new Date() },
    }).select('requestedTime');

    const bookedSlots = confirmedBookings.map(b => b.requestedTime.toISOString());

    res.status(200).json({
      workingHours: shop.workingHours,
      bookedSlots: bookedSlots,
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
