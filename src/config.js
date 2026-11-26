// Runtime settings, read from environment variables (or a .env file next to package.json).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import catalog from './catalog.json' with { type: 'json' };

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const settings = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 4000),
  databaseFile: env.DATABASE_FILE || fileURLToPath(new URL('../data/clinic.db', import.meta.url)),
  // Origins allowed to call the API from a browser, e.g. https://drmujahid.com
  allowedOrigins: list(env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173'),
  // Public website address, used to build "manage your booking" links in messages
  siteUrl: (env.SITE_URL || 'http://localhost:5173').replace(/\/$/, ''),
  jwtSecret: env.JWT_SECRET || (env.NODE_ENV === 'production' ? null : 'dev-only-secret-change-me'),
  tokenHours: Number(env.ADMIN_TOKEN_HOURS || 12),
  trustProxy: env.TRUST_PROXY || 'loopback',
  remindersEnabled: env.REMINDERS !== 'off',
  notify: {
    clinicEmail: env.CLINIC_NOTIFY_EMAIL || '',
    smtpUrl: env.SMTP_URL || '',
    mailFrom: env.MAIL_FROM || `${catalog.clinic.name} <no-reply@localhost>`,
    whatsappToken: env.WHATSAPP_TOKEN || '',
    whatsappPhoneId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappTemplate: env.WHATSAPP_TEMPLATE || '',
    whatsappLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
  },
};

if (!settings.jwtSecret) throw new Error('JWT_SECRET must be set in production');

export const clinic = catalog.clinic;
export const rules = catalog.rules;
export const services = catalog.services;
export const findService = (slug) => services.find((s) => s.slug === slug);
