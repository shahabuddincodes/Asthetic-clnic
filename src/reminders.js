// Sends 24-hour and 2-hour reminders. Runs inside the API process every few minutes;
// each reminder is marked as sent so restarts never send it twice.
import { addDays, clinicClock, instant } from './time.js';

const HOUR = 3600000;

export async function sendDueReminders(db, notifier, nowMs = Date.now()) {
  const today = clinicClock(nowMs).date;
  const rows = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND consent_contact = 1 AND date BETWEEN ? AND ? AND (reminded_24h = 0 OR reminded_2h = 0)").all(today, addDays(today, 2));
  let sent = 0;
  for (const b of rows) {
    const until = instant(b.date, b.start_min) - nowMs;
    if (until <= 0) continue;
    // 2h reminder window: within 2 hours. 24h window: within 24 hours but more than 2.
    if (!b.reminded_2h && until <= 2 * HOUR) {
      db.prepare('UPDATE bookings SET reminded_2h = 1, reminded_24h = 1 WHERE ref = ?').run(b.ref);
      await notifier.patientNow('reminder_2h', b); sent++;
    } else if (!b.reminded_24h && until <= 24 * HOUR && until > 2 * HOUR) {
      db.prepare('UPDATE bookings SET reminded_24h = 1 WHERE ref = ?').run(b.ref);
      await notifier.patientNow('reminder_24h', b); sent++;
    }
  }
  return sent;
}

export function startReminderLoop(db, notifier, everyMinutes = 5) {
  const tick = () => sendDueReminders(db, notifier).catch((e) => console.error('[reminders]', e));
  tick();
  const t = setInterval(tick, everyMinutes * 60000);
  t.unref();
  return () => clearInterval(t);
}
