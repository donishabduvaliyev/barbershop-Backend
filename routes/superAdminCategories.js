import express from 'express';
import SearchCategory from '../models/searchCategory.js';
import ServicesModel from '../models/shopData.js';
import { requireSuperAdmin } from '../middleware/adminAuth.js';

const router = express.Router();
router.use(requireSuperAdmin);

const toShopSummary = (shop) => ({
  id: shop._id,
  name: shop.name,
  category: shop.category,
  image: shop.image,
  rating: shop.rating,
  isOperational: shop.isOperational,
});

// Resolves a manual category's ordered shopIds into shop summaries,
// dropping any shop that's since been archived/deleted rather than
// erroring — the same "stale reference just disappears" behavior the
// discovery-search route uses for customers.
async function withResolvedShops(category) {
  if (category.type !== 'manual' || category.shopIds.length === 0) {
    return { ...category.toObject(), shops: [] };
  }
  const shops = await ServicesModel.find({ _id: { $in: category.shopIds } });
  const shopById = new Map(shops.map((s) => [String(s._id), s]));
  const ordered = category.shopIds
    .map((id) => shopById.get(String(id)))
    .filter(Boolean)
    .map(toShopSummary);
  return { ...category.toObject(), shops: ordered };
}

router.get('/', async (req, res) => {
  try {
    const categories = await SearchCategory.find().sort({ order: 1, createdAt: 1 });
    const resolved = await Promise.all(categories.map(withResolvedShops));
    res.status(200).json({ categories: resolved });
  } catch (error) {
    console.error('Error listing search categories:', error);
    res.status(500).json({ message: 'Server error fetching categories.' });
  }
});

// Only manual categories can be created here — auto categories are a fixed,
// code-defined set (see routes/shops.js's discovery-search autoRule switch)
// since each one needs matching aggregation logic to actually mean anything.
router.post('/', async (req, res) => {
  try {
    const { key, label, icon, order } = req.body;
    if (!key || !label?.en || !label?.uz || !label?.ru) {
      return res.status(400).json({ message: 'key and label (en/uz/ru) are required.' });
    }
    const existing = await SearchCategory.findOne({ key });
    if (existing) return res.status(409).json({ message: 'A category with this key already exists.' });

    const category = await SearchCategory.create({
      key, label, icon: icon || '', type: 'manual', order: order ?? 0,
    });
    res.status(201).json(await withResolvedShops(category));
  } catch (error) {
    console.error('Error creating search category:', error);
    res.status(500).json({ message: 'Server error creating category.' });
  }
});

// label/icon/isActive/order are editable on every category, including
// auto ones — that's just display config, not the underlying rule.
router.patch('/:id', async (req, res) => {
  try {
    const category = await SearchCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Category not found.' });

    const { label, icon, isActive, order } = req.body;
    if (label) category.label = label;
    if (icon !== undefined) category.icon = icon;
    if (isActive !== undefined) category.isActive = isActive;
    if (order !== undefined) category.order = order;
    await category.save();
    res.status(200).json(await withResolvedShops(category));
  } catch (error) {
    console.error('Error updating search category:', error);
    res.status(500).json({ message: 'Server error updating category.' });
  }
});

// Deleting an auto category would leave discovery-search's autoRule switch
// with nothing to attach display config to — those are only ever hidden via
// isActive, never removed. Manual categories are fully owner-created and
// safe to delete outright.
router.delete('/:id', async (req, res) => {
  try {
    const category = await SearchCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Category not found.' });
    if (category.type === 'auto') {
      return res.status(400).json({ message: 'Built-in categories can only be hidden, not deleted.' });
    }
    await category.deleteOne();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting search category:', error);
    res.status(500).json({ message: 'Server error deleting category.' });
  }
});

router.post('/:id/shops', async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ message: 'shopId is required.' });

    const category = await SearchCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Category not found.' });
    if (category.type !== 'manual') return res.status(400).json({ message: 'This category is auto-managed.' });

    if (!category.shopIds.some((id) => String(id) === String(shopId))) {
      category.shopIds.push(shopId);
      await category.save();
    }
    res.status(200).json(await withResolvedShops(category));
  } catch (error) {
    console.error('Error adding shop to category:', error);
    res.status(500).json({ message: 'Server error adding shop.' });
  }
});

router.delete('/:id/shops/:shopId', async (req, res) => {
  try {
    const category = await SearchCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Category not found.' });
    if (category.type !== 'manual') return res.status(400).json({ message: 'This category is auto-managed.' });

    category.shopIds = category.shopIds.filter((id) => String(id) !== String(req.params.shopId));
    await category.save();
    res.status(200).json(await withResolvedShops(category));
  } catch (error) {
    console.error('Error removing shop from category:', error);
    res.status(500).json({ message: 'Server error removing shop.' });
  }
});

// Full replace, not a patch — the admin UI always sends the complete
// drag-reordered list, which is simpler and can't drift from partial diffs.
router.patch('/:id/shops/reorder', async (req, res) => {
  try {
    const { shopIds } = req.body;
    if (!Array.isArray(shopIds)) return res.status(400).json({ message: 'shopIds must be an array.' });

    const category = await SearchCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Category not found.' });
    if (category.type !== 'manual') return res.status(400).json({ message: 'This category is auto-managed.' });

    // Only accept a reordering of the category's existing membership — this
    // endpoint is for reordering, not for smuggling in additions/removals.
    const currentSet = new Set(category.shopIds.map(String));
    const incomingSet = new Set(shopIds.map(String));
    if (currentSet.size !== incomingSet.size || [...currentSet].some((id) => !incomingSet.has(id))) {
      return res.status(400).json({ message: 'Reorder list must contain exactly the category\'s current shops.' });
    }

    category.shopIds = shopIds;
    await category.save();
    res.status(200).json(await withResolvedShops(category));
  } catch (error) {
    console.error('Error reordering category shops:', error);
    res.status(500).json({ message: 'Server error reordering shops.' });
  }
});

export default router;
