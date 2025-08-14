import express from 'express';
import User from '../models/userdata.js';
import ServicesModel from '../models/shopData.js';
import Booking from '../models/bookingHistory.js';
import { sendBookingRequestToAdmin } from '../config/telegramBot.js';

const router = express.Router();

router.post('/get-user', async (req, res) => {
  try {
    const { id } = req.body; // Telegram user ID from frontend

    if (!id) {
      return res.status(400).json({ message: 'Telegram ID is required' });
    }

    const user = await User.findOne({ telegramId: id.toString() });

    if (!user) {
      return res.status(404).json({ message: 'User not found in database' });
    }

    res.json({
      message: 'User data retrieved successfully',
      user: {
        telegramId: user.telegramId,
        name: user.name,
        phone: user.phone,
        email: user.email,
        avatar: user.avatar,
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error retrieving user' });
  }
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
      matchQuery.name.ru = { $regex: name, $options: 'i' };
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
      nearYouShops = await Business.aggregate([
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

router.post('/booking-requests', async (req, res) => {
  try {
    const { shopId, shopName, userTelegramId, userTelegramUsername, requestedTime ,userNumber,userTelegramNumber } = req.body;

    if (!shopId || !userTelegramId || !requestedTime || !userNumber) {
      return res.status(400).json({ message: 'Missing required information.' });
    }

    const newBookingRequest = new Booking({
      shopId,
      shopName,
      userTelegramId,
      userTelegramUsername,
      requestedTime,
      userNumber ,
      userTelegramNumber, 
      status: 'pending', 
    });

    await newBookingRequest.save();

    
    await sendBookingRequestToAdmin(newBookingRequest);

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
      startTime: { $gte: new Date() },
    }).select('startTime');

    const bookedSlots = confirmedBookings.map(b => b.startTime.toISOString());

    res.status(200).json({
      workingHours: shop.workingHours,
      bookedSlots: bookedSlots,
    });

  } catch (error) {
    console.error('Error fetching shop availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


export default router;
