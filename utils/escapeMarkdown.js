// Every message in this app is sent with parse_mode: 'Markdown' (legacy
// Telegram Markdown, not MarkdownV2) — which only treats _, *, ` and [ as
// special. A shop name, customer name, staff name, or owner-typed rejection
// reason containing any of these (very common — "O'Neil's", "Cut_n_Style")
// makes Telegram reject the ENTIRE message with "can't parse entities",
// which notifyUser then swallows silently — the customer or owner just
// never gets that notification, with no visible error anywhere.
//
// Its own file rather than living in telegramFormat.js or botMessages.js —
// those two already import from each other, and this is needed by both.
export function escapeMarkdown(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/([_*`[])/g, '\\$1');
}
