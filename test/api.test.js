// End-to-end API tests against an in-memory database with a fixed clock.
// Clock: Monday 16 Nov 2026, 09:00 clinic time (PKT, UTC+5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.REMINDERS = 'off';
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth.js');
const { sendDueReminders } = await import('../src/reminders.js');
const { instant } = await import('../src/time.js');

let clock = Date.parse('2026-11-16T04:00:00Z');
const sent = [];
const notifier = {
  patient: (kind, b) => sent.push({ to: 'patient', kind, ref: b.ref }),
  clinic: (kind, b) => sent.push({ to: 'clinic', kind, ref: b?.ref }),
  patientNow: async (kind, b) => { sent.push({ to: 'patient', kind, ref: b.ref }); },
};
const db = openDb(':memory:');
let server, base;

before(async () => {
  db.prepare('INSERT INTO admins (email, name, role, password_hash) VALUES (?,?,?,?)').run('doctor@clinic.test', 'Doctor', 'admin', hashPassword('correct horse battery'));
  db.prepare('INSERT INTO admins (email, name, role, password_hash) VALUES (?,?,?,?)').run('desk@clinic.test', 'Reception', 'staff', hashPassword('reception password'));
  server = createApp({ db, notifier, now: () => clock, origins: ['http://localhost:5173'] }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); db.close(); });

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
};
const patient = (o = {}) => ({ service: 'consultation', date: '2026-11-17', start: 600, name: 'Ayesha Khan', phone: '0300 1234567', email: 'ayesha@example.com', visitType: 'in-person', returning: 'new', consent: { policy: true, contact: true }, ...o });
const login = async (email = 'doctor@clinic.test', password = 'correct horse battery') => (await call('POST', '/admin/login', { email, password })).body.token;

test('health and catalog', async () => {
  assert.equal((await call('GET', '/health')).body.ok, true);
  const c = await call('GET', '/catalog');
  assert.ok(c.body.services.find((s) => s.slug === 'botox'));
  assert.equal(c.body.clinic.utcOffsetMinutes, 300);
});

test('availability honours hours, notice period and closed days', async () => {
  const today = await call('GET', '/availability?service=consultation&date=2026-11-16');
  assert.equal(today.body.slots[0].start, 660, 'first slot is 11:00 with 2h notice at 09:00');
  assert.ok(!today.body.slots.some((s) => s.start >= 810 && s.start < 870), 'lunch break 13:30–14:30 is free of slots');
  const sunday = await call('GET', '/availability?service=consultation&date=2026-11-22');
  assert.equal(sunday.body.status, 'closed');
  assert.deepEqual(sunday.body.slots, []);
  const days = await call('GET', '/availability/days?service=botox');
  assert.equal(days.body.days.length, 61);
  assert.equal(days.body.days.find((d) => d.date === '2026-11-22').available, false);
  assert.equal((await call('GET', '/availability?service=nope&date=2026-11-16')).status, 404);
  assert.equal((await call('GET', '/availability?service=consultation&date=2026-02-30')).status, 400);
});

test('booking, double-booking protection and buffer', async () => {
  const a = await call('POST', '/bookings', patient());
  assert.equal(a.status, 201);
  assert.match(a.body.booking.ref, /^BK-[A-Z2-9]{6}$/);
  assert.ok(a.body.manageToken.length > 20);
  assert.equal(a.body.booking.phone, '+923001234567');
  assert.deepEqual(sent.slice(-2).map((s) => s.kind), ['confirmation', 'admin_new_booking']);

  const again = await call('POST', '/bookings', patient({ name: 'Someone Else' }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'slot_taken');

  const slots = (await call('GET', '/availability?service=consultation&date=2026-11-17')).body.slots.map((s) => s.start);
  assert.ok(!slots.includes(600) && !slots.includes(630), '10:00 booked, 10:30 blocked by the 10-minute buffer');
  assert.ok(slots.includes(660));
});

test('simultaneous requests for one slot: exactly one wins', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/bookings', patient({ date: '2026-11-18', start: 900, name: 'Racer ' + i }))));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
});

test('input validation', async () => {
  const bad = await call('POST', '/bookings', patient({ phone: '12', date: '2026-11-19' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.details[0].field, 'phone');
  assert.equal((await call('POST', '/bookings', patient({ consent: { policy: false, contact: true }, date: '2026-11-19' }))).status, 400);
  assert.equal((await call('POST', '/bookings', patient({ website: 'http://spam', date: '2026-11-19' }))).status, 400, 'honeypot');
  assert.equal((await call('POST', '/bookings', patient({ date: '2026-11-15' }))).body.error.code, 'day_unavailable', 'past date');
  assert.equal((await call('POST', '/bookings', patient({ date: '2027-03-01' }))).body.error.code, 'day_unavailable', 'beyond window');
  assert.equal((await call('POST', '/bookings', patient({ start: 605, date: '2026-11-19' }))).body.error.code, 'slot_taken', 'off-grid time');
});

test('video visits use the video consultation length', async () => {
  const v = await call('POST', '/bookings', patient({ service: 'botox', visitType: 'video', date: '2026-11-19', start: 600 }));
  assert.equal(v.status, 201);
  assert.equal(v.body.booking.service.slug, 'video');
  assert.equal(v.body.booking.duration, 20);
});

test('patient can view, move and cancel with their link token only', async () => {
  const { body } = await call('POST', '/bookings', patient({ date: '2026-11-20', start: 660 }));
  const { ref } = body.booking, token = body.manageToken;
  assert.equal((await call('GET', `/bookings/${ref}?token=wrong-token-123`)).status, 404);
  const view = await call('GET', `/bookings/${ref}`, null, { 'X-Manage-Token': token });
  assert.equal(view.body.booking.canChange, true);
  assert.equal(view.body.booking.note, undefined);

  const moved = await call('POST', `/bookings/${ref}/reschedule`, { token, date: '2026-11-20', start: 720 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.booking.time, '12:00 PM');
  const slots = (await call('GET', '/availability?service=consultation&date=2026-11-20')).body.slots.map((s) => s.start);
  assert.ok(slots.includes(660), 'old time is free again');

  const cancelled = await call('POST', `/bookings/${ref}/cancel`, { token, reason: 'Travelling' });
  assert.equal(cancelled.body.booking.status, 'cancelled');
  assert.ok((await call('GET', '/availability?service=consultation&date=2026-11-20')).body.slots.some((s) => s.start === 720));
});

test('online changes close 12 hours before', async () => {
  const { body } = await call('POST', '/bookings', patient({ date: '2026-11-16', start: 900 })); // today 3 PM
  const r = await call('POST', `/bookings/${body.booking.ref}/cancel`, { token: body.manageToken });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'too_late');
});

test('contact form', async () => {
  assert.equal((await call('POST', '/contact', { name: 'Bilal', phone: '03001112222', message: 'Do you offer evening slots?' })).status, 201);
  assert.equal((await call('POST', '/contact', { name: 'B', phone: '1', message: '' })).status, 400);
});

test('admin sign-in and permissions', async () => {
  assert.equal((await call('POST', '/admin/login', { email: 'doctor@clinic.test', password: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/admin/bookings')).status, 401);
  assert.equal((await call('GET', '/admin/bookings', null, { Authorization: 'Bearer forged.token.here' })).status, 401);
  const staff = await login('desk@clinic.test', 'reception password');
  assert.equal((await call('GET', '/admin/bookings', null, { Authorization: `Bearer ${staff}` })).status, 200);
  assert.equal((await call('GET', '/admin/users', null, { Authorization: `Bearer ${staff}` })).status, 403);
});

test('admin manages bookings, blocks, messages and exports', async () => {
  const auth = { Authorization: `Bearer ${await login()}` };
  const list = await call('GET', '/admin/bookings?from=2026-11-16&to=2026-11-30&status=active', null, auth);
  assert.ok(list.body.total >= 3);
  const ref = list.body.bookings[0].ref;

  const detail = await call('GET', `/admin/bookings/${ref}`, null, auth);
  assert.ok(detail.body.history.some((h) => h.action === 'booking.create'));

  const done = await call('PATCH', `/admin/bookings/${ref}`, { status: 'completed', staffNote: 'Plan: 3 peels' }, auth);
  assert.equal(done.body.booking.status, 'completed');
  assert.equal(done.body.booking.staffNote, 'Plan: 3 peels');

  const walkIn = await call('POST', '/admin/bookings', { ...patient({ date: '2026-11-16', start: 630, name: 'Walk In' }), source: 'walk-in' }, auth);
  assert.equal(walkIn.status, 201, 'staff can book inside the 2-hour notice window');

  const block = await call('POST', '/admin/blocks', { date: '2026-11-24', start: 600, end: 780, reason: 'Training' }, auth);
  assert.equal(block.status, 201);
  const slots = (await call('GET', '/availability?service=consultation&date=2026-11-24')).body.slots.map((s) => s.start);
  assert.equal(slots[0], 870, 'morning blocked');
  assert.equal((await call('DELETE', `/admin/blocks/${block.body.block.id}`, null, auth)).status, 200);

  const schedule = await call('GET', '/admin/schedule?date=2026-11-17', null, auth);
  assert.equal(schedule.body.bookings.length, 1);

  const msgs = await call('GET', '/admin/messages', null, auth);
  assert.equal(msgs.body.messages[0].name, 'Bilal');
  assert.equal((await call('PATCH', `/admin/messages/${msgs.body.messages[0].id}`, { status: 'read' }, auth)).status, 200);

  const stats = await call('GET', '/admin/stats', null, auth);
  assert.ok(stats.body.today.appointments >= 1);

  const csv = await call('GET', '/admin/bookings/export.csv?from=2026-11-16&to=2026-11-30', null, auth);
  assert.match(csv.body, /^ref,date,time/);

  const erase = await call('DELETE', `/admin/bookings/${ref}/personal-data`, null, auth);
  assert.equal(erase.status, 200);
  assert.equal((await call('GET', `/admin/bookings/${ref}`, null, auth)).body.booking.name, '[deleted]');
});

test('reminders are sent once, 24 hours and 2 hours before', async () => {
  const { body } = await call('POST', '/bookings', patient({ date: '2026-11-25', start: 600 }));
  const at = instant('2026-11-25', 600);
  const kinds = () => sent.filter((s) => s.ref === body.booking.ref).map((s) => s.kind);
  await sendDueReminders(db, notifier, at - 30 * 3600000);
  assert.ok(!kinds().includes('reminder_24h'), 'not yet at 30h');
  await sendDueReminders(db, notifier, at - 23 * 3600000);
  await sendDueReminders(db, notifier, at - 22 * 3600000);
  assert.equal(kinds().filter((k) => k === 'reminder_24h').length, 1);
  await sendDueReminders(db, notifier, at - 90 * 60000);
  assert.equal(kinds().filter((k) => k === 'reminder_2h').length, 1);
});

test('unknown routes and bad JSON give clean errors', async () => {
  assert.equal((await call('GET', '/nope')).body.error.code, 'not_found');
  const res = await fetch(base + '/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal((await res.json()).error.code, 'invalid_json');
});
