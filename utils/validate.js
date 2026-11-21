/**
 * Shared Input Validation Utilities
 * Prevents CastError 500 crashes, type confusion, and malformed payloads.
 */

export function isValidObjectId(id) {
  if (!id) return false;
  if (typeof id === 'object' && id._bsontype === 'ObjectId') return true;
  return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
}

export function isValidDateKey(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return false;
  }
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function parseNonNegativeNumber(val) {
  if (val === undefined || val === null || val === '' || typeof val === 'boolean') {
    return null;
  }
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  return num;
}

export function sanitizeString(val, maxLen = 300) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}
