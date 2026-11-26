import { z } from 'zod';
import { isDate } from './time.js';

const clean = (max) => z.string().trim().max(max);
export const phoneOk = (v) => { const s = v.replace(/[\s-]/g, ''); return /^(\+?92|0)?3\d{9}$/.test(s) || /^\+\d{8,15}$/.test(s); };

export const dateStr = z.string().refine(isDate, 'Use a date in the form YYYY-MM-DD');
export const minuteOfDay = z.coerce.number().int().min(0).max(1440);
const phone = clean(24).refine(phoneOk, 'Enter a valid mobile number, e.g. 0300 1234567');
const email = z.union([z.literal(''), z.string().trim().max(120).email('Check your email address')]).optional();

export const bookingInput = z.object({
  service: clean(60).min(1, 'Choose a treatment'),
  date: dateStr,
  start: minuteOfDay,
  name: clean(80).min(2, 'Please enter your full name'),
  phone,
  email,
  visitType: z.enum(['in-person', 'video']).default('in-person'),
  returning: z.union([z.boolean(), z.enum(['new', 'returning'])]).default(false).transform((v) => v === true || v === 'returning'),
  note: clean(500).optional(),
  consent: z.object({ policy: z.literal(true, 'Please accept the cancellation policy'), contact: z.boolean().default(false) }),
  website: z.string().max(0, 'Invalid submission').optional(), // honeypot: must stay empty
});

export const rescheduleInput = z.object({ token: z.string().min(10).max(80), date: dateStr, start: minuteOfDay });
export const cancelInput = z.object({ token: z.string().min(10).max(80), reason: clean(300).optional() });

export const contactInput = z.object({
  name: clean(80).min(2, 'Please enter your name'),
  phone,
  email,
  message: clean(2000).min(5, 'Please write a short message'),
  website: z.string().max(0, 'Invalid submission').optional(),
});

export const loginInput = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });

export const adminBookingInput = bookingInput.extend({
  consent: z.object({ policy: z.boolean().default(true), contact: z.boolean().default(true) }).default({ policy: true, contact: true }),
  status: z.enum(['pending', 'confirmed']).default('confirmed'),
  ignoreNotice: z.boolean().default(true),
  source: z.enum(['phone', 'walk-in', 'whatsapp', 'website']).default('phone'),
});

export const adminUpdateInput = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
  staffNote: clean(1000).optional(),
  date: dateStr.optional(),
  start: minuteOfDay.optional(),
  reason: clean(300).optional(),
  notifyPatient: z.boolean().default(true),
}).refine((v) => (v.date == null) === (v.start == null), 'Send both date and start to move a booking');

export const blockInput = z.object({
  date: dateStr,
  start: minuteOfDay.default(0),
  end: minuteOfDay.default(1440),
  reason: clean(200).optional(),
}).refine((v) => v.end > v.start, 'End must be after start');

export const listQuery = z.object({
  from: dateStr.optional(), to: dateStr.optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'active']).optional(),
  q: clean(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
