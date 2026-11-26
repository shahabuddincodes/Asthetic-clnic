# Dr. Mujahid Aesthetics — Clinic API

Author: Muhammad Riaz

Node.js + Express backend for the clinic website: online booking with real availability,
patient self-service (reschedule / cancel), contact messages, WhatsApp/email notifications
with automatic reminders, and a staff API for the clinic dashboard.

- **Node 20.12+**, Express, SQLite (`better-sqlite3`) — one process, one database file, no extra services.
- Double-booking is impossible: every booking is checked and written inside one locked transaction.
- Treatments, durations, opening hours and booking rules come from the website's own
  `src/data.js` and `src/config.js` (copied into `src/catalog.json` by `npm run sync-catalog`).

## Run it locally

```bash
cd backend
npm install
cp .env.example .env        # for local use you can leave most values empty
npm run create-admin        # first staff account (asks for email, name, password)
npm run dev                 # http://localhost:4000/api
npm test                    # 13 end-to-end API tests
```

Then build the website against it:

```bash
cd ..                       # website folder
VITE_API_URL=http://localhost:4000 npm run dev
```

Without `VITE_API_URL` the website stays in preview mode (bookings are kept in the browser),
which is how the shared preview link works.

## Changing hours, treatments or rules

Edit `src/config.js` / `src/data.js` in the website, then in `backend/`:

```bash
npm run sync-catalog && npm start
```

## Deploying

Any host that runs Node and keeps a persistent disk works (a VPS, Railway, Render with a disk, Fly.io).

1. Set the variables from `.env.example` — at minimum `JWT_SECRET`, `ALLOWED_ORIGINS`, `SITE_URL`, `TRUST_PROXY`.
2. `npm ci --omit=dev && npm run create-admin && npm start` (or `docker build -t clinic-api . && docker run -p 4000:4000 -v clinic-data:/data --env-file .env clinic-api`).
3. Put it behind HTTPS (e.g. `api.drmujahid.com`).
4. Build the website with `VITE_API_URL=https://api.drmujahid.com npm run build` and upload `dist/`.
5. Back up `clinic.db` daily (copy the file, or `sqlite3 clinic.db ".backup backup.db"`).

## Notifications

| Event | Patient | Clinic |
|---|---|---|
| New booking | Confirmation with reference and manage link | Email alert |
| Rescheduled / cancelled | Update message | Email alert |
| Staff confirms a pending booking | Confirmation | — |
| 24 h and 2 h before | Reminder (only if the patient agreed to be contacted) | — |
| Contact form | — | Email with the message |

Channels switch on when configured: WhatsApp Cloud API (`WHATSAPP_*`) and/or email (`SMTP_URL`).
Every attempt is logged in the `notifications` table and shown on the booking's admin detail.

## API reference

All responses are JSON. Errors look like `{ "error": { "code": "slot_taken", "message": "…" } }`.
Times are minutes after clinic midnight (600 = 10:00 AM); dates are clinic-local `YYYY-MM-DD`.

### Public (used by the website)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/catalog` | Clinic details, services and public booking rules |
| GET | `/api/availability/days?service=botox` | Next 60 days, which have free times |
| GET | `/api/availability?service=botox&date=2026-11-17` | Free start times for a day |
| POST | `/api/bookings` | Create a booking → `{ booking, manageToken }` |
| GET | `/api/bookings/:ref` | View own booking (header `X-Manage-Token`) |
| POST | `/api/bookings/:ref/reschedule` | `{ token, date, start }` — up to 12 h before |
| POST | `/api/bookings/:ref/cancel` | `{ token, reason? }` — up to 12 h before |
| POST | `/api/contact` | Contact form message |

`POST /api/bookings` body:

```json
{ "service": "botox", "date": "2026-11-17", "start": 600,
  "name": "Ayesha Khan", "phone": "0300 1234567", "email": "ayesha@example.com",
  "visitType": "in-person", "returning": "new", "note": "",
  "consent": { "policy": true, "contact": true } }
```

### Staff (header `Authorization: Bearer <token>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/login` | `{ email, password }` → `{ token, admin }` (valid 12 h) |
| GET | `/api/admin/me` · POST `/api/admin/me/password` | Current user · change password |
| GET | `/api/admin/stats` | Today, next 7 days, pending, new messages, top treatments |
| GET | `/api/admin/schedule?date=` | A day's bookings, blocks and free consultation times |
| GET | `/api/admin/bookings?from&to&status&q&page` | Search and list (`status=active` = pending + confirmed) |
| GET | `/api/admin/bookings/:ref` | Detail with change history and messages sent |
| POST | `/api/admin/bookings` | Phone / walk-in booking (may skip the 2-hour notice) |
| PATCH | `/api/admin/bookings/:ref` | `{ status, staffNote, date+start, reason, notifyPatient }` |
| GET | `/api/admin/bookings/export.csv?from&to` | Spreadsheet export |
| DELETE | `/api/admin/bookings/:ref/personal-data` | Erase a patient's details (admin role) |
| GET/POST/DELETE | `/api/admin/blocks` | Block time off (leave, training); reports bookings that clash |
| GET · PATCH | `/api/admin/messages` · `/:id` | Contact inbox; mark read / archived |
| GET/POST/DELETE | `/api/admin/users` | Staff accounts, roles `admin` / `staff` (admin role) |
| GET | `/api/admin/audit` | Who did what, when (admin role) |

## Security and privacy

- Passwords hashed with scrypt; staff tokens signed (HS256) and short-lived; sign-in rate limited.
- Patients manage bookings with a random link token; only its SHA-256 hash is stored.
- Rate limits on booking, contact and manage routes; honeypot field against form bots; 20 KB body limit.
- Helmet security headers; CORS limited to `ALLOWED_ORIGINS`.
- No medical history is collected online; staff notes are visible only in the staff API.
- Every change is written to `audit_log`; CSV cells are escaped against spreadsheet formula injection.

## Not included yet

- The staff dashboard screens (this API is ready for them).
- Online payments / deposits.
- Video-call links (send them manually, or add a Zoom/Google Meet integration).
