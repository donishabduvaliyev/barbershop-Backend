// Photo storage: the actual image bytes live in a Cloudflare R2 bucket (an
// S3-compatible object store), never in MongoDB — only the resulting public
// URL gets saved on the shop/staff document. Every image is resized and
// re-encoded to WebP here before upload, so "lightweight and fast to load"
// is guaranteed by what we store, not by whatever optimization tier a
// storage provider happens to offer.
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import crypto from 'crypto';

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// maxWidth differs by use: shop photos are viewed large (cards, hero
// images), staff photos are small circular avatars — no reason to ship
// avatar-sized bytes at hero-image resolution.
export async function uploadImage(buffer, { folder, maxWidth = 1200 }) {
  const optimized = await sharp(buffer)
    .rotate() // respects the original photo's EXIF orientation before stripping it
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  const key = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.webp`;

  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: optimized,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable', // filename is content-addressed-ish (random+timestamp), safe to cache forever
  }));

  return { url: `${PUBLIC_URL}/${key}`, key };
}

// Best-effort cleanup when a photo is replaced/removed — never allowed to
// block or fail the request that triggered it (a stray orphaned file in R2
// costs nothing meaningful; failing to update the shop record would be worse).
export async function deleteImageByUrl(url) {
  if (!url || !PUBLIC_URL || !url.startsWith(PUBLIC_URL)) return;
  const key = url.slice(PUBLIC_URL.length + 1);
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error('Failed to delete R2 object:', err.message);
  }
}
