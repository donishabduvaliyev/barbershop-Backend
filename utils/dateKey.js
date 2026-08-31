// Converts a Date to a 'YYYY-MM-DD' key in server-local time, consistently
// used wherever a whole calendar day matters (staff days-off, "is this the
// same day" checks) rather than an exact timestamp. Manual getFullYear/
// getMonth/getDate avoids the locale ambiguity of toLocaleDateString.
export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Start/end of the given 'YYYY-MM-DD' day in server-local time — used to
// query bookings falling within that whole day.
export function dateKeyToRange(dateKey) {
  const start = new Date(`${dateKey}T00:00:00`);
  const end = new Date(`${dateKey}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
