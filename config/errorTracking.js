// Lightweight wrapper around Sentry so the rest of the codebase never
// imports the SDK directly. Off by default — SENTRY_DSN is unset in local
// dev, so captureError() is a no-op there and this file adds nothing to the
// local console.error behavior every catch block already has.
//
// This exists because notifyUser (config/telegramBot.js) and every other
// Telegram-send catch block only ever logged failures to a server console
// nobody watches in real time — a blocked bot, a bad Markdown escape, or a
// rate limit all looked identical: silence. Wiring the same catch blocks to
// also report here means those failures show up somewhere a person actually
// gets notified, without changing any of the existing error-handling logic.
import * as Sentry from '@sentry/node';

let initialized = false;

export function initErrorTracking() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('ℹ️ SENTRY_DSN not set — error tracking disabled (errors still log to console).');
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Pure error tracking, not performance monitoring — this app has no
    // need for request tracing, and sampling that in adds overhead and
    // Sentry-quota cost for no benefit here.
    tracesSampleRate: 0,
  });
  initialized = true;
  console.log('✅ Error tracking initialized.');
}

// `context` is attached as Sentry's "extra" data — pass whatever identifies
// what was happening (a booking id, a chat id, a route name) since a bare
// stack trace rarely tells you which shop or customer was involved.
export function captureError(err, context = {}) {
  if (initialized) {
    Sentry.captureException(err, { extra: context });
  }
}
