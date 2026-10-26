/**
 * NoSQL Injection Sanitizer Middleware
 * Recursively strips keys starting with '$' or containing '.' from request body, query, and params.
 * Prevents attackers from injecting MongoDB query operators (e.g. $gt, $ne, $where).
 */

function sanitizeObject(target) {
  if (!target || typeof target !== 'object') {
    return target;
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      target[i] = sanitizeObject(target[i]);
    }
    return target;
  }

  const keys = Object.keys(target);
  for (const key of keys) {
    // Drop dangerous MongoDB query operator keys or dot-notation traversal keys
    if (key.startsWith('$') || key.includes('.')) {
      delete target[key];
    } else if (typeof target[key] === 'object' && target[key] !== null) {
      target[key] = sanitizeObject(target[key]);
    }
  }

  return target;
}

export function sanitizeRequest(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    sanitizeObject(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    sanitizeObject(req.params);
  }
  next();
}

export default sanitizeRequest;
