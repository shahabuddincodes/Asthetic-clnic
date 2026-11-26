// Clinic staff API. Every route except /login needs "Authorization: Bearer <token>".
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { issueToken, requireAdmin, verifyPassword, hashPassword } from '../auth.js';
import { adminView, byRef, createBooking, moveBooking, setStatus } from '../bookings.js';
import { freeSlots } from '../availability.js';
import { findService } from '../config.js';
import { audit } from '../db.js';
import { HttpError } from '../errors.js';
import { addDays, clinicClock, fmtTime } from '../time.js';
import { adminBookingInput, adminUpdateInput, blockInput, dateStr, listQuery, loginInput } from '../validation.js';
import { z } from 'zod';

const loginLimiter = rateLimit({
  windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many sign-in attempts. Try again in 15 minutes.' } }),
});

export function adminRoutes({ db, notifier, now }) {
  const r = Router();
  const get = (ref) => { const b = byRef(db, ref); if (!b) throw new HttpError(404, 'not_found', 'Booking not found.'); return b; };

  // ── Sign in ────────────────────────────────────────────────
  r.post('/login', loginLimiter, (req, res) => {
    const { email, password } = loginInput.parse(req.body);
    const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      audit(db, email, 'admin.login_failed');
      throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
    }
    db.prepare("UPDATE admins SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(admin.id);
    audit(db, admin.email, 'admin.login');
    res.json({ token: issueToken(admin, now()), admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  });

  r.use(requireAdmin());
  const actor = (req) => req.admin.email;

  r.get('/me', (req, res) => {
    const a = db.prepare('SELECT id, email, name, role, last_login_at lastLoginAt FROM admins WHERE id = ?').get(req.admin.sub);
    if (!a) throw new HttpError(401, 'unauthorized', 'Please sign in again.');
    res.json({ admin: a });
  });

  r.post('/me/password', (req, res) => {
    const { current, next } = z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters') }).parse(req.body);
    const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.sub);
    if (!verifyPassword(current, a.password_hash)) throw new HttpError(400, 'bad_credentials', 'Current password is incorrect.');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), a.id);
    audit(db, a.email, 'admin.password_change');
    res.json({ ok: true });
  });

  // ── Dashboard ──────────────────────────────────────────────
  r.get('/stats', (_req, res) => {
    const today = clinicClock(now()).date, week = addDays(today, 6);
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    res.json({
      today: { date: today, appointments: count("SELECT COUNT(*) n FROM bookings WHERE date = ? AND status IN ('pending','confirmed')", today) },
      next7Days: count("SELECT COUNT(*) n FROM bookings WHERE date BETWEEN ? AND ? AND status IN ('pending','confirmed')", today, week),
      pending: count("SELECT COUNT(*) n FROM bookings WHERE status = 'pending' AND date >= ?", today),
      newMessages: count("SELECT COUNT(*) n FROM messages WHERE status = 'new'"),
      last30Days: db.prepare("SELECT status, COUNT(*) n FROM bookings WHERE date BETWEEN ? AND ? GROUP BY status").all(addDays(today, -30), today),
      topServices: db.prepare("SELECT service_name name, COUNT(*) n FROM bookings WHERE date >= ? AND status != 'cancelled' GROUP BY service_name ORDER BY n DESC LIMIT 5").all(addDays(today, -90)),
    });
  });

  // ── Bookings ───────────────────────────────────────────────
  r.get('/bookings', (req, res) => {
    const q = listQuery.parse(req.query);
    const where = [], args = {};
    if (q.from) { where.push('date >= @from'); args.from = q.from; }
    if (q.to) { where.push('date <= @to'); args.to = q.to; }
    if (q.status === 'active') where.push("status IN ('pending','confirmed')");
    else if (q.status) { where.push('status = @status'); args.status = q.status; }
    if (q.q) { where.push('(patient_name LIKE @q OR phone LIKE @q OR ref LIKE @q OR email LIKE @q)'); args.q = `%${q.q}%`; }
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM bookings ${sqlWhere}`).get(args).n;
    const rows = db.prepare(`SELECT * FROM bookings ${sqlWhere} ORDER BY date, start_min LIMIT @limit OFFSET @offset`).all({ ...args, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    res.json({ total, page: q.page, pageSize: q.pageSize, bookings: rows.map(adminView) });
  });

  r.get('/bookings/export.csv', (req, res) => {
    const q = listQuery.parse(req.query);
    const rows = db.prepare('SELECT * FROM bookings WHERE date BETWEEN ? AND ? ORDER BY date, start_min').all(q.from || '0000-01-01', q.to || '9999-12-31');
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
    const head = ['ref', 'date', 'time', 'duration', 'service', 'visit_type', 'status', 'name', 'phone', 'email', 'source', 'created_at'];
    const lines = rows.map((b) => [b.ref, b.date, fmtTime(b.start_min), b.end_min - b.start_min, b.service_name, b.visit_type, b.status, b.patient_name, b.phone, b.email, b.source, b.created_at].map(cell).join(','));
    audit(db, actor(req), 'bookings.export', null, { from: q.from, to: q.to, rows: rows.length });
    res.type('text/csv').attachment(`bookings-${q.from || 'all'}-${q.to || 'all'}.csv`).send([head.join(','), ...lines].join('\n'));
  });

  r.get('/bookings/:ref', (req, res) => {
    const b = get(req.params.ref);
    const history = db.prepare('SELECT actor, action, detail, created_at at FROM audit_log WHERE target = ? ORDER BY id').all(b.ref);
    const messages = db.prepare('SELECT kind, channel, recipient, status, error, created_at at FROM notifications WHERE booking_ref = ? ORDER BY id').all(b.ref);
    res.json({ booking: adminView(b), history, notifications: messages });
  });

  // Phone, WhatsApp or walk-in bookings entered by staff.
  r.post('/bookings', (req, res) => {
    const input = adminBookingInput.parse(req.body);
    const { booking, token } = createBooking(db, input, { nowMs: now(), actor: actor(req), source: input.source, status: input.status, ignoreNotice: input.ignoreNotice });
    if (input.consent.contact) notifier.patient('confirmation', booking, { token });
    res.status(201).json({ booking: adminView(booking) });
  });

  r.patch('/bookings/:ref', (req, res) => {
    const u = adminUpdateInput.parse(req.body);
    let b = get(req.params.ref);
    const before = b.status;
    if (u.date != null) {
      b = moveBooking(db, b, u.date, u.start, { nowMs: now(), actor: actor(req), ignoreNotice: true });
      if (u.notifyPatient) notifier.patient('rescheduled', b);
    }
    if (u.status && u.status !== b.status) {
      b = setStatus(db, b, u.status, { actor: actor(req), reason: u.reason });
      if (u.notifyPatient && u.status === 'cancelled') notifier.patient('cancellation', b);
      if (u.notifyPatient && u.status === 'confirmed' && before === 'pending') notifier.patient('confirmed_by_clinic', b);
    }
    if (u.staffNote != null) {
      db.prepare("UPDATE bookings SET staff_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref = ?").run(u.staffNote, b.ref);
      audit(db, actor(req), 'booking.note', b.ref);
      b = byRef(db, b.ref);
    }
    res.json({ booking: adminView(b) });
  });

  // Right to erasure: keeps the time slot record for reporting, removes who it was.
  r.delete('/bookings/:ref/personal-data', requireAdmin('admin'), (req, res) => {
    const b = get(req.params.ref);
    db.prepare(`UPDATE bookings SET patient_name='[deleted]', phone='[deleted]', email=NULL, note=NULL, staff_note=NULL, consent_contact=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref=?`).run(b.ref);
    db.prepare("UPDATE notifications SET recipient='[deleted]' WHERE booking_ref=?").run(b.ref);
    audit(db, actor(req), 'booking.erase', b.ref);
    res.json({ ok: true });
  });

  // ── Schedule & blocked time ────────────────────────────────
  r.get('/schedule', (req, res) => {
    const date = dateStr.parse(req.query.date || clinicClock(now()).date);
    const bookings = db.prepare("SELECT * FROM bookings WHERE date = ? AND status != 'cancelled' ORDER BY start_min").all(date).map(adminView);
    const blocks = db.prepare('SELECT id, start_min start, end_min end, reason FROM blocks WHERE date = ? ORDER BY start_min').all(date);
    const consult = findService('consultation');
    res.json({ date, bookings, blocks, freeConsultationSlots: freeSlots(db, date, consult.duration, now(), { ignoreNotice: true }).map((s) => ({ start: s, time: fmtTime(s) })) });
  });

  r.get('/blocks', (req, res) => {
    const from = dateStr.parse(req.query.from || clinicClock(now()).date);
    res.json({ blocks: db.prepare('SELECT id, date, start_min start, end_min end, reason, created_by createdBy FROM blocks WHERE date >= ? ORDER BY date, start_min').all(from) });
  });

  r.post('/blocks', (req, res) => {
    const v = blockInput.parse(req.body);
    const clashes = db.prepare("SELECT ref, start_min, patient_name FROM bookings WHERE date = ? AND status IN ('pending','confirmed') AND start_min < ? AND end_min > ?").all(v.date, v.end, v.start);
    const { lastInsertRowid: id } = db.prepare('INSERT INTO blocks (date, start_min, end_min, reason, created_by) VALUES (?,?,?,?,?)').run(v.date, v.start, v.end, v.reason || null, actor(req));
    audit(db, actor(req), 'block.create', String(id), v);
    // Existing bookings are kept; staff are told which ones need moving.
    res.status(201).json({ block: { id: Number(id), ...v }, affectedBookings: clashes.map((c) => ({ ref: c.ref, time: fmtTime(c.start_min), name: c.patient_name })) });
  });

  r.delete('/blocks/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(req.params.id));
    if (!changes) throw new HttpError(404, 'not_found', 'Block not found.');
    audit(db, actor(req), 'block.delete', req.params.id);
    res.json({ ok: true });
  });

  // ── Messages from the contact form ─────────────────────────
  r.get('/messages', (req, res) => {
    const status = z.enum(['new', 'read', 'archived', 'all']).default('all').parse(req.query.status);
    const rows = status === 'all' ? db.prepare("SELECT * FROM messages WHERE status != 'archived' ORDER BY id DESC LIMIT 200").all() : db.prepare('SELECT * FROM messages WHERE status = ? ORDER BY id DESC LIMIT 200').all(status);
    res.json({ messages: rows.map((m) => ({ id: m.id, name: m.name, phone: m.phone, email: m.email, message: m.message, status: m.status, createdAt: m.created_at })) });
  });

  r.patch('/messages/:id', (req, res) => {
    const { status } = z.object({ status: z.enum(['new', 'read', 'archived']) }).parse(req.body);
    const { changes } = db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (!changes) throw new HttpError(404, 'not_found', 'Message not found.');
    res.json({ ok: true });
  });

  // ── Staff accounts (admins only) ───────────────────────────
  r.get('/users', requireAdmin('admin'), (_req, res) => {
    res.json({ users: db.prepare('SELECT id, email, name, role, last_login_at lastLoginAt, created_at createdAt FROM admins ORDER BY id').all() });
  });

  r.post('/users', requireAdmin('admin'), (req, res) => {
    const u = z.object({ email: z.string().trim().email(), name: z.string().trim().min(2).max(80), role: z.enum(['admin', 'staff']).default('staff'), password: z.string().min(10, 'Use at least 10 characters') }).parse(req.body);
    if (db.prepare('SELECT 1 FROM admins WHERE email = ?').get(u.email)) throw new HttpError(409, 'exists', 'A user with that email already exists.');
    const { lastInsertRowid: id } = db.prepare('INSERT INTO admins (email, name, role, password_hash) VALUES (?,?,?,?)').run(u.email, u.name, u.role, hashPassword(u.password));
    audit(db, actor(req), 'user.create', u.email, { role: u.role });
    res.status(201).json({ user: { id: Number(id), email: u.email, name: u.name, role: u.role } });
  });

  r.delete('/users/:id', requireAdmin('admin'), (req, res) => {
    if (Number(req.params.id) === req.admin.sub) throw new HttpError(400, 'self', 'You cannot remove your own account.');
    const { changes } = db.prepare('DELETE FROM admins WHERE id = ?').run(Number(req.params.id));
    if (!changes) throw new HttpError(404, 'not_found', 'User not found.');
    audit(db, actor(req), 'user.delete', req.params.id);
    res.json({ ok: true });
  });

  r.get('/audit', requireAdmin('admin'), (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
    res.json({ entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) });
  });

  return r;
}
