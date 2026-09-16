// A separate, private R2 bucket for database backups — deliberately NOT
// the same bucket config/r2.js uploads shop/staff photos to. That bucket is
// served publicly (R2_PUBLIC_URL points customers' browsers straight at
// it); backups contain real names, phone numbers and booking history, so
// they belong in a bucket with no public URL attached at all. Same
// Cloudflare account and credentials, just a different, private bucket —
// create it in the R2 dashboard and set R2_BACKUP_BUCKET_NAME to use this.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import zlib from 'zlib';

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BACKUP_BUCKET = process.env.R2_BACKUP_BUCKET_NAME;

export function backupsConfigured() {
  return !!BACKUP_BUCKET;
}

// `data` is any JSON-serializable value (here, always an array of plain
// documents) — gzipped before upload since a full collection dump is
// mostly repetitive text and compresses well, and R2 storage/egress is
// billed by the byte.
export async function uploadBackup(key, data) {
  if (!BACKUP_BUCKET) {
    throw new Error('R2_BACKUP_BUCKET_NAME is not set — cannot upload backup.');
  }
  const gzipped = zlib.gzipSync(JSON.stringify(data));
  await r2.send(new PutObjectCommand({
    Bucket: BACKUP_BUCKET,
    Key: key,
    Body: gzipped,
    ContentType: 'application/json',
    ContentEncoding: 'gzip',
  }));
}
