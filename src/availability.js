// Availability engine: the single source of truth for which times can be booked.
// It mirrors the website's preview logic (src/booking.js) but uses real bookings and blocks.
import { rules } from './config.js';
import { addDays, clinicClock, toMin, weekday } from './time.js';

/** Busy intervals [start, end) for a date: active bookings and admin blocks. */
export function busyIntervals(db, date, { excludeRef } = {}) {
  const booked = db.prepare(`SELECT start_min s, end_min e FROM bookings WHERE date = ? AND status IN ('pending','confirmed') AND ref IS NOT ?`).all(date, excludeRef ?? null);
  const blocks = db.prepare('SELECT start_min s, end_min e FROM blocks WHERE date = ?').all(date);
  return [...booked, ...blocks];
}

/** Is the date inside the booking window and open? */
export function dayStatus(date, nowMs) {
  const today = clinicClock(nowMs).date;
  if (date < today) return 'past';
  if (date > addDays(today, rules.windowDays)) return 'too_far';
  if (rules.holidays.includes(date)) return 'holiday';
  if (!(rules.hours[weekday(date)] || []).length) return 'closed';
  return 'open';
}

/**
 * Free start times for a date and duration.
 * options.ignoreNotice lets clinic staff add same-day walk-ins inside the notice period.
 */
export function freeSlots(db, date, duration, nowMs = Date.now(), options = {}) {
  if (dayStatus(date, nowMs) !== 'open') return [];
  const clock = clinicClock(nowMs);
  const earliest = date === clock.date ? clock.minutes + (options.ignoreNotice ? 0 : rules.minNoticeMinutes) : -1;
  const busy = busyIntervals(db, date, options);
  const buffer = rules.bufferMinutes;
  const out = [];
  for (const [a, b] of rules.hours[weekday(date)]) {
    for (let s = toMin(a); s + duration <= toMin(b); s += rules.slotStepMinutes) {
      if (s < earliest) continue;
      const e = s + duration;
      if (!busy.some((x) => s < x.e + buffer && x.s < e + buffer)) out.push(s);
    }
  }
  return out;
}

/** Each day in the booking window with whether it has at least one free slot. */
export function windowDays(db, duration, nowMs = Date.now()) {
  const today = clinicClock(nowMs).date;
  return Array.from({ length: rules.windowDays + 1 }, (_, i) => {
    const date = addDays(today, i);
    const status = dayStatus(date, nowMs);
    const slots = status === 'open' ? freeSlots(db, date, duration, nowMs).length : 0;
    return { date, available: slots > 0, slots, status: status === 'open' && !slots ? 'full' : status };
  });
}
