// Patient and clinic notifications.
// Channels switch on automatically when configured in .env:
//   WhatsApp Cloud API (WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID), email (SMTP_URL).
// With neither configured, messages are written to the console and the notifications table,
// so nothing is lost during development.
import nodemailer from 'nodemailer';
import { clinic, settings } from './config.js';
import { fmtDate, fmtTime } from './time.js';

/** 0300 1234567 / +92 300 1234567 → 923001234567 (WhatsApp format). */
export function toWhatsAppNumber(phone) {
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('0')) d = '92' + d.slice(1);
  if (d.length === 10 && d.startsWith('3')) d = '92' + d;
  return d;
}

const when = (b) => `${fmtDate(b.date)} at ${fmtTime(b.start_min)} ${clinic.timeZoneLabel}`;
export const manageUrl = (ref, token) => `${settings.siteUrl}/#manage-${ref}-${token}`;

/** Message text for each event. */
export function compose(kind, b, extra = {}) {
  const first = b.patient_name.split(' ')[0];
  const where = b.visit_type === 'video' ? 'Video consultation — the link will be sent before your appointment.' : `Address: ${clinic.address}`;
  const manage = extra.token ? `\nReschedule or cancel: ${manageUrl(b.ref, extra.token)}` : '';
  switch (kind) {
    case 'confirmation':
      return { subject: `Booking ${b.status === 'pending' ? 'received' : 'confirmed'} · ${b.ref}`,
        text: `Hi ${first}, your ${b.service_name} with ${clinic.doctor} is ${b.status === 'pending' ? 'requested' : 'confirmed'} for ${when(b)}.\n${where}\nReference: ${b.ref}${manage}\n— ${clinic.name}, ${clinic.phone}` };
    case 'confirmed_by_clinic':
      return { subject: `Booking confirmed · ${b.ref}`, text: `Hi ${first}, the clinic has confirmed your ${b.service_name} on ${when(b)}. Reference: ${b.ref}.\n— ${clinic.name}` };
    case 'rescheduled':
      return { subject: `Booking moved · ${b.ref}`, text: `Hi ${first}, your ${b.service_name} is now on ${when(b)}. Reference: ${b.ref}.\n— ${clinic.name}` };
    case 'cancellation':
      return { subject: `Booking cancelled · ${b.ref}`, text: `Hi ${first}, your ${b.service_name} on ${when(b)} has been cancelled. To book again, visit ${settings.siteUrl} or call ${clinic.phone}.\n— ${clinic.name}` };
    case 'reminder_24h':
    case 'reminder_2h':
      return { subject: `Reminder: ${b.service_name} ${kind === 'reminder_24h' ? 'tomorrow' : 'today'}`,
        text: `Hi ${first}, a reminder of your ${b.service_name} with ${clinic.doctor} on ${when(b)}.\n${where}\nNeed to change it? Call ${clinic.phone}.\n— ${clinic.name}` };
    case 'admin_new_booking':
      return { subject: `New booking ${b.ref}: ${b.service_name}, ${b.date} ${fmtTime(b.start_min)}`,
        text: `${b.patient_name} (${b.phone}${b.email ? ', ' + b.email : ''}) booked ${b.service_name} — ${b.visit_type} — on ${when(b)}.\nStatus: ${b.status}. ${b.is_returning ? 'Returning' : 'New'} patient.${b.note ? '\nNote: ' + b.note : ''}` };
    case 'admin_cancellation':
      return { subject: `Cancelled ${b.ref}: ${b.date} ${fmtTime(b.start_min)}`, text: `${b.patient_name} cancelled ${b.service_name} on ${when(b)}.${b.cancel_reason ? '\nReason: ' + b.cancel_reason : ''}` };
    default:
      throw new Error('Unknown notification ' + kind);
  }
}

export function createNotifier(db, cfg = settings.notify) {
  const mailer = cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : null;
  const record = (ref, kind, channel, recipient, status, error) =>
    db.prepare('INSERT INTO notifications (booking_ref, kind, channel, recipient, status, error) VALUES (?,?,?,?,?,?)').run(ref ?? null, kind, channel, recipient ?? null, status, error ?? null);

  async function whatsapp(to, text) {
    const body = cfg.whatsappTemplate
      ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: cfg.whatsappTemplate, language: { code: cfg.whatsappLang }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.whatsappPhoneId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.whatsappToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function attempt(ref, kind, channel, to, fn) {
    try { await fn(); record(ref, kind, channel, to, 'sent'); }
    catch (e) { record(ref, kind, channel, to, 'failed', e.message); console.warn(`[notify] ${kind} via ${channel} failed: ${e.message}`); }
  }

  /** Send a patient-facing message by every channel that is configured and consented to. */
  async function patient(kind, b, extra) {
    const msg = compose(kind, b, extra);
    let sent = false;
    if (b.consent_contact && cfg.whatsappToken && cfg.whatsappPhoneId) {
      const to = toWhatsAppNumber(b.phone);
      await attempt(b.ref, kind, 'whatsapp', to, () => whatsapp(to, msg.text)); sent = true;
    }
    if (b.email && mailer) {
      await attempt(b.ref, kind, 'email', b.email, () => mailer.sendMail({ from: cfg.mailFrom, to: b.email, subject: msg.subject, text: msg.text })); sent = true;
    }
    if (!sent) { record(b.ref, kind, 'log', b.phone, 'skipped', 'No channel configured'); if (settings.env !== 'test') console.log(`[notify:${kind}] → ${b.phone}\n${msg.text}\n`); }
  }

  /** Alert the clinic (email to CLINIC_NOTIFY_EMAIL). */
  async function clinicAlert(kind, b, override) {
    const msg = override || compose(kind, b);
    if (mailer && cfg.clinicEmail) return attempt(b?.ref, kind, 'email', cfg.clinicEmail, () => mailer.sendMail({ from: cfg.mailFrom, to: cfg.clinicEmail, subject: msg.subject, text: msg.text }));
    record(b?.ref, kind, 'log', cfg.clinicEmail || 'clinic', 'skipped', 'No channel configured');
    if (settings.env !== 'test') console.log(`[clinic:${kind}] ${msg.subject}`);
  }

  // Notifications never block or fail the request that triggered them.
  const bg = (p) => { p.catch((e) => console.error('[notify]', e)); };
  return {
    patient: (kind, b, extra) => bg(patient(kind, b, extra)),
    clinic: (kind, b, override) => bg(clinicAlert(kind, b, override)),
    patientNow: patient,
  };
}
