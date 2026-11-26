// Routes the website calls. No login; abuse is limited by rate limits and the honeypot field.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { clinic, findService, rules, services } from '../config.js';
import { freeSlots, windowDays, dayStatus } from '../availability.js';
import { byRef, createBooking, moveBooking, patientCanChange, patientView, setStatus } from '../bookings.js';
import { tokenMatches } from '../auth.js';
import { audit } from '../db.js';
import { HttpError } from '../errors.js';
import { fmtTime } from '../time.js';
import { bookingInput, cancelInput, contactInput, dateStr, rescheduleInput } from '../validation.js';

const limiter = (limit, minutes = 15) => rateLimit({
  windowMs: minutes * 60000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Please wait a few minutes or call the clinic.' } }),
});

export function publicRoutes({ db, notifier, now }) {
  const r = Router();

  const serviceOr404 = (slug, visitType) => {
    const s = findService(visitType === 'video' ? 'video' : slug);
    if (!s) throw new HttpError(404, 'unknown_service', 'That treatment is not available for online booking.');
    return s;
  };
  // A patient proves they own a booking with the token from their confirmation link.
  const ownBooking = (ref, token) => {
    const b = byRef(db, ref);
    if (!b || !token || !tokenMatches(token, b.manage_token)) throw new HttpError(404, 'not_found', 'We could not find that booking. Check the link in your confirmation message.');
    return b;
  };

  r.get('/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, time: new Date(now()).toISOString() }); });

  r.get('/catalog', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      clinic,
      rules: { slotStepMinutes: rules.slotStepMinutes, windowDays: rules.windowDays, minNoticeMinutes: rules.minNoticeMinutes, cancellationCutoffHours: rules.cancellationCutoffHours, confirmation: rules.confirmation, videoConsultations: rules.videoConsultations },
      services,
    });
  });

  // Which days have free times, for the calendar.
  r.get('/availability/days', (req, res) => {
    const s = serviceOr404(req.query.service, req.query.visitType);
    res.set('Cache-Control', 'no-store');
    res.json({ service: s.slug, duration: s.duration, days: windowDays(db, s.duration, now()) });
  });

  // Free start times for one day.
  r.get('/availability', (req, res) => {
    const s = serviceOr404(req.query.service, req.query.visitType);
    const date = dateStr.parse(req.query.date);
    res.set('Cache-Control', 'no-store');
    res.json({ service: s.slug, duration: s.duration, date, status: dayStatus(date, now()), slots: freeSlots(db, date, s.duration, now()).map((start) => ({ start, time: fmtTime(start) })) });
  });

  r.post('/bookings', limiter(10), (req, res) => {
    const input = bookingInput.parse(req.body);
    const { booking, token } = createBooking(db, input, { nowMs: now() });
    notifier.patient('confirmation', booking, { token });
    notifier.clinic('admin_new_booking', booking);
    res.status(201).json({ booking: patientView(booking, now()), manageToken: token });
  });

  r.get('/bookings/:ref', limiter(60), (req, res) => {
    const b = ownBooking(req.params.ref, req.get('x-manage-token') || req.query.token);
    res.json({ booking: patientView(b, now()) });
  });

  r.post('/bookings/:ref/cancel', limiter(20), (req, res) => {
    const { token, reason } = cancelInput.parse(req.body);
    const b = ownBooking(req.params.ref, token);
    if (b.status === 'cancelled') return res.json({ booking: patientView(b, now()) });
    if (!patientCanChange(b, now())) throw new HttpError(409, 'too_late', `Online changes close ${rules.cancellationCutoffHours} hours before the appointment. Please call ${clinic.phone}.`);
    const updated = setStatus(db, b, 'cancelled', { actor: 'patient', reason });
    notifier.patient('cancellation', updated);
    notifier.clinic('admin_cancellation', updated);
    res.json({ booking: patientView(updated, now()) });
  });

  r.post('/bookings/:ref/reschedule', limiter(20), (req, res) => {
    const { token, date, start } = rescheduleInput.parse(req.body);
    const b = ownBooking(req.params.ref, token);
    if (!patientCanChange(b, now())) throw new HttpError(409, 'too_late', `Online changes close ${rules.cancellationCutoffHours} hours before the appointment. Please call ${clinic.phone}.`);
    const updated = moveBooking(db, b, date, start, { nowMs: now() });
    notifier.patient('rescheduled', updated);
    notifier.clinic('admin_new_booking', updated, { subject: `Moved ${b.ref} to ${date} ${fmtTime(start)}`, text: `${b.patient_name} moved ${b.service_name} from ${b.date} ${fmtTime(b.start_min)} to ${date} ${fmtTime(start)}.` });
    res.json({ booking: patientView(updated, now()) });
  });

  r.post('/contact', limiter(5), (req, res) => {
    const m = contactInput.parse(req.body);
    const { lastInsertRowid: id } = db.prepare('INSERT INTO messages (name, phone, email, message) VALUES (?,?,?,?)').run(m.name, m.phone, m.email || null, m.message);
    audit(db, 'patient', 'message.create', String(id));
    notifier.clinic('admin_message', null, { subject: `Website message from ${m.name}`, text: `${m.name} (${m.phone}${m.email ? ', ' + m.email : ''}) wrote:\n\n${m.message}` });
    res.status(201).json({ ok: true, id: Number(id) });
  });

  return r;
}
