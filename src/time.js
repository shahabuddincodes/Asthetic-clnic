// Date and time helpers. All booking dates are clinic-local "YYYY-MM-DD" strings and all
// times are minutes after clinic midnight, so the server's own time zone never matters.
import { clinic } from './config.js';

const pad = (n) => String(n).padStart(2, '0');
const OFFSET_MS = clinic.utcOffsetMinutes * 60000;

/** Current clinic-local date and minute of day. */
export function clinicClock(nowMs = Date.now()) {
  const d = new Date(nowMs + OFFSET_MS); // UTC fields now show clinic-local time
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
export const weekday = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Absolute UTC timestamp (ms) of a clinic-local date + minute. */
export const instant = (date, minutes) => Date.parse(date + 'T00:00:00Z') + minutes * 60000 - OFFSET_MS;

export function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
export function fmtDate(date) {
  return new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
