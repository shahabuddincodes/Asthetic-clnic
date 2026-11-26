// Copies the services, clinic details and booking rules from the website
// (../src/data.js and ../src/config.js) into src/catalog.json, so the website
// and the API always agree on durations and opening hours.
// Run after editing treatments or hours on the website:  npm run sync-catalog
import { writeFileSync } from 'node:fs';
import { bookable } from '../../src/data.js';
import { clinic, bookingRules } from '../../src/config.js';

const catalog = {
  generatedAt: new Date().toISOString(),
  clinic: {
    name: clinic.name, doctor: clinic.doctor, address: clinic.address, phone: clinic.phone,
    email: clinic.email, whatsapp: clinic.whatsapp, timeZoneLabel: clinic.timeZoneLabel, utcOffsetMinutes: clinic.utcOffsetMinutes,
  },
  rules: bookingRules,
  services: bookable.map((b) => ({ slug: b.slug, name: b.name, duration: b.duration, category: b.category || 'consultation', video: !!b.video, consultFirst: !!b.consultFirst })),
};
writeFileSync(new URL('../src/catalog.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
console.log(`catalog.json: ${catalog.services.length} services`);
