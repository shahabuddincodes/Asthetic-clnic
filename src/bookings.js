// Booking rules that every route goes through: create, move, cancel.
import { randomInt } from "node:crypto";
import { findService, rules } from "./config.js";
import { freeSlots, dayStatus } from "./availability.js";
import { audit } from "./db.js";
import { HttpError } from "./errors.js";
import { hashToken, newManageToken } from "./auth.js";
import { toWhatsAppNumber } from "./notify.js";
import { fmtTime, instant } from "./time.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const newRef = () =>
  "BK-" +
  Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    "",
  );

export const byRef = (db, ref) =>
  db
    .prepare("SELECT * FROM bookings WHERE ref = ?")
    .get(String(ref).toUpperCase());

function serviceFor(slug, visitType) {
  const s = findService(visitType === "video" ? "video" : slug);
  if (!s)
    throw new HttpError(
      400,
      "unknown_service",
      "That treatment is not available for online booking.",
    );
  if (visitType === "video" && !rules.videoConsultations)
    throw new HttpError(
      400,
      "video_unavailable",
      "Video consultations are not offered at the moment.",
    );
  return s;
}

function assertSlotFree(db, date, start, duration, nowMs, opts) {
  const status = dayStatus(date, nowMs);
  const reason = {
    past: "That date has passed.",
    too_far: `Bookings open up to ${rules.windowDays} days ahead.`,
    holiday: "The clinic is closed that day.",
    closed: "The clinic is closed that day.",
  }[status];
  if (reason) throw new HttpError(409, "day_unavailable", reason);
  if (!freeSlots(db, date, duration, nowMs, opts).includes(start)) {
    throw new HttpError(
      409,
      "slot_taken",
      "Sorry, that time is no longer available. Please pick another slot.",
    );
  }
}

/** Creates a booking inside an IMMEDIATE transaction, so two people can never get the same slot. */
export function createBooking(
  db,
  input,
  {
    nowMs = Date.now(),
    actor = "patient",
    source = "website",
    status,
    ignoreNotice = false,
  } = {},
) {
  const service = serviceFor(input.service, input.visitType);
  const token = newManageToken();
  const run = db.transaction(() => {
    assertSlotFree(db, input.date, input.start, service.duration, nowMs, {
      ignoreNotice,
    });
    let ref;
    do ref = newRef();
    while (byRef(db, ref));
    db.prepare(
      `INSERT INTO bookings (ref, service_slug, service_name, date, start_min, end_min, visit_type, patient_name, phone, email, note, is_returning, status, source, manage_token, consent_contact)
                VALUES (@ref,@slug,@sname,@date,@start,@end,@visit,@name,@phone,@email,@note,@returning,@status,@source,@token,@contact)`,
    ).run({
      ref,
      slug: service.slug,
      sname: service.name,
      date: input.date,
      start: input.start,
      end: input.start + service.duration,
      visit: input.visitType,
      name: input.name,
      phone: "+" + toWhatsAppNumber(input.phone),
      email: input.email || null,
      note: input.note || null,
      returning: input.returning ? 1 : 0,
      status:
        status || (rules.confirmation === "pending" ? "pending" : "confirmed"),
      source,
      token: hashToken(token),
      contact: input.consent?.contact ? 1 : 0,
    });
    audit(db, actor, "booking.create", ref, {
      date: input.date,
      start: input.start,
      service: service.slug,
      source,
    });
    return byRef(db, ref);
  });
  return { booking: run.immediate(), token };
}

/** Whether a patient may still change the booking online. */
export function changeDeadline(b) {
  return instant(b.date, b.start_min) - rules.cancellationCutoffHours * 3600000;
}
export function patientCanChange(b, nowMs = Date.now()) {
  return (
    ["pending", "confirmed"].includes(b.status) && nowMs <= changeDeadline(b)
  );
}

export function moveBooking(
  db,
  b,
  date,
  start,
  { nowMs = Date.now(), actor = "patient", ignoreNotice = false } = {},
) {
  const duration = b.end_min - b.start_min;
  const run = db.transaction(() => {
    assertSlotFree(db, date, start, duration, nowMs, {
      excludeRef: b.ref,
      ignoreNotice,
    });
    db.prepare(
      `UPDATE bookings SET date=?, start_min=?, end_min=?, reminded_24h=0, reminded_2h=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref=?`,
    ).run(date, start, start + duration, b.ref);
    audit(db, actor, "booking.move", b.ref, {
      from: `${b.date} ${fmtTime(b.start_min)}`,
      to: `${date} ${fmtTime(start)}`,
    });
    return byRef(db, b.ref);
  });
  return run.immediate();
}

export function setStatus(db, b, status, { actor, reason } = {}) {
  db.prepare(
    `UPDATE bookings SET status=?, cancel_reason=COALESCE(?, cancel_reason), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref=?`,
  ).run(status, reason ?? null, b.ref);
  audit(db, actor, "booking.status", b.ref, {
    from: b.status,
    to: status,
    reason,
  });
  return byRef(db, b.ref);
}

/** What a patient sees (no internal notes, no token hash). */
export function patientView(b, nowMs = Date.now()) {
  return {
    ref: b.ref,
    service: { slug: b.service_slug, name: b.service_name },
    date: b.date,
    start: b.start_min,
    end: b.end_min,
    duration: b.end_min - b.start_min,
    time: fmtTime(b.start_min),
    visitType: b.visit_type,
    status: b.status,
    name: b.patient_name,
    phone: b.phone,
    email: b.email,
    canChange: patientCanChange(b, nowMs),
    changeBy: new Date(changeDeadline(b)).toISOString(),
  };
}

/** What clinic staff see. */
export function adminView(b) {
  return {
    ...patientView(b),
    canChange: undefined,
    changeBy: undefined,
    note: b.note,
    staffNote: b.staff_note,
    returning: !!b.is_returning,
    source: b.source,
    consentContact: !!b.consent_contact,
    cancelReason: b.cancel_reason,
    reminders: { h24: !!b.reminded_24h, h2: !!b.reminded_2h },
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}
