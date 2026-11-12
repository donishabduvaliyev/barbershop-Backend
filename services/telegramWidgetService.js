import Booking from '../models/bookingHistory.js';
import { t, normalizeLanguage } from '../utils/botMessages.js';
import { escapeMarkdown } from '../utils/escapeMarkdown.js';

const ACTIVE_STATUSES = ['pending', 'confirmed'];

/**
 * Calculates live open hourly slots for a shop on a target date.
 * Takes into account shop working hours, past hours for today, and existing active bookings.
 */
export async function calculateShopSlotsForDate(shop, targetDate, staffId = null) {
  if (!shop) return [];
  const dateObj = new Date(targetDate);
  const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });

  // Match working hours covering this day
  const wh = (shop.workingHours || []).find((entry) => entry.days && entry.days.includes(dayName));
  if (!wh || !wh.from || !wh.to) {
    return [];
  }

  const [fromHour] = wh.from.split(':').map(Number);
  const [toHour] = wh.to.split(':').map(Number);

  // Determine beginning and end of target day
  const startOfDay = new Date(dateObj);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateObj);
  endOfDay.setHours(23, 59, 59, 999);

  // Active bookings on this day for this shop
  const query = {
    shopId: shop._id,
    status: { $in: ACTIVE_STATUSES },
    requestedTime: { $gte: startOfDay, $lte: endOfDay },
  };
  if (staffId) {
    query.staffId = staffId;
  }

  const activeBookings = await Booking.find(query).select('requestedTime staffId virtualSlot');

  const now = new Date();
  const isToday = startOfDay.toDateString() === now.toDateString();
  const currentHour = now.getHours();

  const slots = [];
  const capacity = staffId ? 1 : (shop.staff?.length || shop.capacity || 1);

  for (let h = fromHour; h < toHour; h++) {
    // If today, filter out past hours
    if (isToday && h <= currentHour) {
      continue;
    }

    const timeStr = `${String(h).padStart(2, '0')}:00`;

    // Count how many active bookings exist for this specific hour
    const bookedAtHour = activeBookings.filter((b) => {
      const bHour = new Date(b.requestedTime).getHours();
      return bHour === h;
    });

    const isAvailable = bookedAtHour.length < capacity;

    slots.push({
      time: timeStr,
      hour: h,
      isAvailable,
      bookedCount: bookedAtHour.length,
      capacity,
    });
  }

  return slots;
}

/**
 * Generates self-contained micro-HTML/CSS/JS for the In-Chat Booking Widget.
 * Complies with Telegram Bot API 10.4 widget guidelines (<32KB, zero external dependencies).
 */
export function buildBookingWidgetHtml({
  shop,
  dateStr,
  slots = [],
  staffList = [],
  selectedStaffId = '',
  selectedTime = '',
  lang = 'uz',
}) {
  const normLang = normalizeLanguage(lang);
  const shopName = shop.name?.[normLang] || shop.name?.en || shop.name?.uz || 'SmartChair Salon';

  const todayStr = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const dayAfter = new Date();
  dayAfter.setDate(dayAfter.getDate() + 2);
  const dayAfterStr = dayAfter.toISOString().slice(0, 10);

  const activeDate = dateStr || todayStr;

  const datesConfig = [
    { key: todayStr, label: t(normLang, 'customer.widgetToday') },
    { key: tomorrowStr, label: t(normLang, 'customer.widgetTomorrow') },
    { key: dayAfterStr, label: t(normLang, 'customer.widgetDayAfter') },
  ];

  return `<!DOCTYPE html>
<html lang="${normLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #0A0A0C);
    --surface: var(--tg-theme-secondary-bg-color, #141419);
    --text: var(--tg-theme-text-color, #FAF6F0);
    --hint: var(--tg-theme-hint-color, #8E8B85);
    --gold: #D4AF5A;
    --gold-glow: rgba(212, 175, 90, 0.25);
    --border: rgba(212, 175, 90, 0.2);
    --radius: 14px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 12px;
    font-size: 13px;
    line-height: 1.4;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .brand {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    color: var(--gold);
    text-transform: uppercase;
  }
  .shop-name {
    font-size: 16px;
    font-weight: 700;
    color: var(--text);
    margin-top: 2px;
  }
  .section-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--hint);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 10px 0 6px;
  }
  .date-pills {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .date-pill {
    flex: 1;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--text);
    padding: 7px 4px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s ease;
  }
  .date-pill.active {
    background: var(--gold);
    color: #0A0A0C;
    border-color: var(--gold);
    box-shadow: 0 2px 8px var(--gold-glow);
  }
  .staff-scroll {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 4px;
    margin-bottom: 8px;
    scrollbar-width: none;
  }
  .staff-scroll::-webkit-scrollbar { display: none; }
  .staff-chip {
    flex: 0 0 auto;
    padding: 6px 12px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    color: var(--text);
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .staff-chip.active {
    background: rgba(212, 175, 90, 0.18);
    border-color: var(--gold);
    color: var(--gold);
    font-weight: 600;
  }
  .slots-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    margin-bottom: 14px;
  }
  .slot-btn {
    padding: 8px 0;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s ease;
  }
  .slot-btn.disabled {
    opacity: 0.28;
    cursor: not-allowed;
    text-decoration: line-through;
    background: transparent;
  }
  .slot-btn.active {
    background: var(--gold);
    color: #0A0A0C;
    border-color: var(--gold);
    box-shadow: 0 0 10px var(--gold-glow);
  }
  .empty-slots {
    padding: 16px;
    text-align: center;
    color: var(--hint);
    font-size: 12px;
    grid-column: span 4;
  }
  .action-btn {
    width: 100%;
    padding: 12px;
    background: var(--gold);
    color: #0A0A0C;
    border: none;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: opacity 0.2s;
  }
  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div>
      <div class="brand">SmartChair · In-Chat Booking</div>
      <div class="shop-name">${shopName}</div>
    </div>
    <span style="font-size: 18px;">✂️</span>
  </div>

  <div class="date-pills">
    ${datesConfig.map((d) => `
      <div class="date-pill ${d.key === activeDate ? 'active' : ''}" onclick="selectDate('${d.key}')">${d.label}</div>
    `).join('')}
  </div>

  ${staffList.length > 0 ? `
    <div class="staff-scroll">
      <div class="staff-chip ${!selectedStaffId ? 'active' : ''}" onclick="selectStaff('')">${t(normLang, 'customer.widgetAnyBarber')}</div>
      ${staffList.map((s) => `
        <div class="staff-chip ${s._id.toString() === selectedStaffId ? 'active' : ''}" onclick="selectStaff('${s._id}')">${s.name}</div>
      `).join('')}
    </div>
  ` : ''}

  <div class="section-label">${t(normLang, 'customer.widgetAvailableSlots')}</div>
  <div class="slots-grid">
    ${slots.length > 0 ? slots.map((s) => `
      <button class="slot-btn ${!s.isAvailable ? 'disabled' : ''} ${s.time === selectedTime ? 'active' : ''}"
        ${!s.isAvailable ? 'disabled' : ''} onclick="selectSlot('${s.time}')">${s.time}</button>
    `).join('') : `<div class="empty-slots">${t(normLang, 'customer.widgetNoSlots')}</div>`}
  </div>

  <button id="bookBtn" class="action-btn" ${!selectedTime ? 'disabled' : ''} onclick="submitBooking()">
    <span>⚡️</span>
    <span id="btnText">${selectedTime ? `${t(normLang, 'customer.widgetBookNow')} (${selectedTime})` : t(normLang, 'customer.widgetSelectSlotFirst')}</span>
  </button>
</div>

<script>
  let state = {
    shopId: "${shop._id}",
    date: "${activeDate}",
    staffId: "${selectedStaffId || ''}",
    time: "${selectedTime || ''}"
  };

  function sendQuery(data) {
    if (window.Telegram && window.Telegram.Widget && typeof window.Telegram.Widget.postQuery === 'function') {
      window.Telegram.Widget.postQuery(data);
    } else if (window.TelegramWebviewProxy) {
      window.TelegramWebviewProxy.postEvent('widget_query', JSON.stringify(data));
    } else {
      console.log('[Widget query dispatched]:', data);
    }
  }

  function selectDate(d) {
    state.date = d;
    state.time = '';
    sendQuery({ action: 'change_date', shopId: state.shopId, date: d, staffId: state.staffId });
  }

  function selectStaff(sId) {
    state.staffId = sId;
    state.time = '';
    sendQuery({ action: 'change_staff', shopId: state.shopId, date: state.date, staffId: sId });
  }

  function selectSlot(tStr) {
    state.time = tStr;
    document.querySelectorAll('.slot-btn').forEach(btn => {
      if (btn.innerText.trim() === tStr) btn.classList.add('active');
      else btn.classList.remove('active');
    });
    const btn = document.getElementById('bookBtn');
    btn.disabled = false;
    document.getElementById('btnText').innerText = "${t(normLang, 'customer.widgetBookNow')} (" + tStr + ")";
  }

  function submitBooking() {
    if (!state.time) return;
    const btn = document.getElementById('bookBtn');
    btn.disabled = true;
    btn.innerText = "⏳ ${t(normLang, 'customer.widgetBookNow')}...";
    sendQuery({
      action: 'confirm_booking',
      shopId: state.shopId,
      date: state.date,
      time: state.time,
      staffId: state.staffId
    });
  }
</script>
</body>
</html>`;
}

/**
 * Generates self-contained micro-HTML/CSS/JS for the Interactive Appointment Ticket Widget.
 * Includes a live client-side countdown timer updating every second and direct action controls.
 */
export function buildTicketWidgetHtml({ booking, lang = 'uz' }) {
  const normLang = normalizeLanguage(lang);
  const shopName = booking.shopName || 'SmartChair Salon';
  const staffName = booking.staffName || '';
  const requestedDate = new Date(booking.requestedTime);
  const isoTime = requestedDate.toISOString();

  const formattedDate = requestedDate.toLocaleDateString(normLang === 'ru' ? 'ru-RU' : (normLang === 'en' ? 'en-US' : 'uz-UZ'), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const isConfirmed = booking.status === 'confirmed';
  const statusLabel = isConfirmed
    ? t(normLang, 'customer.widgetTicketConfirmed')
    : t(normLang, 'customer.widgetTicketPending');

  return `<!DOCTYPE html>
<html lang="${normLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #0A0A0C);
    --surface: var(--tg-theme-secondary-bg-color, #141419);
    --text: var(--tg-theme-text-color, #FAF6F0);
    --hint: var(--tg-theme-hint-color, #8E8B85);
    --gold: #D4AF5A;
    --green: #22C55E;
    --red: #EF4444;
    --border: rgba(212, 175, 90, 0.25);
    --radius: 16px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 12px;
    font-size: 13px;
  }
  .ticket {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 6px 20px rgba(0,0,0,0.25);
  }
  .status-tag {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    background: ${isConfirmed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(212, 175, 90, 0.15)'};
    color: ${isConfirmed ? 'var(--green)' : 'var(--gold)'};
    border: 1px solid ${isConfirmed ? 'rgba(34, 197, 94, 0.3)' : 'rgba(212, 175, 90, 0.3)'};
    margin-bottom: 8px;
  }
  .title {
    font-size: 17px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 4px;
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--hint);
    font-size: 12.5px;
    margin-bottom: 14px;
  }
  .countdown-box {
    background: rgba(212, 175, 90, 0.08);
    border: 1px dashed var(--gold);
    border-radius: 12px;
    padding: 10px;
    text-align: center;
    margin-bottom: 14px;
  }
  .countdown-label {
    font-size: 10.5px;
    color: var(--gold);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .countdown-digits {
    font-size: 18px;
    font-weight: 800;
    color: var(--text);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .btn {
    padding: 9px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06);
    color: var(--text);
    transition: all 0.15s ease;
  }
  .btn-danger {
    color: var(--red);
    border-color: rgba(239, 68, 68, 0.25);
  }
</style>
</head>
<body>
<div class="ticket">
  <div class="status-tag">${statusLabel}</div>
  <div class="title">${shopName}</div>
  <div class="details">
    <div>🗓 ${formattedDate}</div>
    ${staffName ? `<div>✂️ ${staffName}</div>` : ''}
  </div>

  <div class="countdown-box">
    <div class="countdown-label">${t(normLang, 'customer.widgetTimeRemaining')}</div>
    <div id="countdown" class="countdown-digits">--:--:--</div>
  </div>

  <div class="actions">
    <button class="btn" onclick="rescheduleBooking()">🔄 ${t(normLang, 'customer.widgetReschedule')}</button>
    <button class="btn btn-danger" onclick="cancelBooking()">❌ ${t(normLang, 'customer.widgetCancel')}</button>
  </div>
</div>

<script>
  const targetTime = new Date("${isoTime}").getTime();

  function sendQuery(data) {
    if (window.Telegram && window.Telegram.Widget && typeof window.Telegram.Widget.postQuery === 'function') {
      window.Telegram.Widget.postQuery(data);
    } else if (window.TelegramWebviewProxy) {
      window.TelegramWebviewProxy.postEvent('widget_query', JSON.stringify(data));
    } else {
      console.log('[Widget query dispatched]:', data);
    }
  }

  function updateTimer() {
    const now = Date.now();
    const diff = targetTime - now;
    const el = document.getElementById('countdown');
    if (diff <= 0) {
      el.innerText = "00:00:00";
      return;
    }
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((diff / 1000 / 60) % 60);
    const seconds = Math.floor((diff / 1000) % 60);

    let str = "";
    if (days > 0) str += days + "d ";
    str += String(hours).padStart(2, '0') + ":" +
           String(minutes).padStart(2, '0') + ":" +
           String(seconds).padStart(2, '0');
    el.innerText = str;
  }

  updateTimer();
  setInterval(updateTimer, 1000);

  function rescheduleBooking() {
    sendQuery({ action: 'reschedule_booking', bookingId: "${booking._id}" });
  }

  function cancelBooking() {
    if (confirm("${t(normLang, 'customer.widgetCancelConfirm')}")) {
      sendQuery({ action: 'cancel_booking', bookingId: "${booking._id}" });
    }
  }
</script>
</body>
</html>`;
}

/**
 * Builds standard inline keyboard fallback for clients without sendWidget support.
 */
export function buildCompactFallbackKeyboard({ shop, dateStr, slots = [], lang = 'uz', webAppUrl = '' }) {
  const normLang = normalizeLanguage(lang);
  const rows = [];

  // Group slots in rows of 3
  const availableSlots = slots.filter((s) => s.isAvailable);
  for (let i = 0; i < Math.min(availableSlots.length, 9); i += 3) {
    const chunk = availableSlots.slice(i, i + 3);
    rows.push(
      chunk.map((s) => ({
        text: `⚡️ ${s.time}`,
        callback_data: `wslot_${shop._id}_${dateStr}_${s.hour}`,
      }))
    );
  }

  // Mini App launcher row
  if (webAppUrl) {
    rows.push([
      {
        text: `🚀 ${t(normLang, 'customer.openShopButton')}`,
        web_app: { url: `${webAppUrl}/service/${shop._id}` },
      },
    ]);
  }

  return { inline_keyboard: rows };
}
