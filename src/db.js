// SQLite storage. One file, no separate database server; back it up by copying data/clinic.db
// (or use `sqlite3 clinic.db ".backup backup.db"` while running).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  service_slug    TEXT NOT NULL,
  service_name    TEXT NOT NULL,
  date            TEXT NOT NULL,              -- clinic-local YYYY-MM-DD
  start_min       INTEGER NOT NULL,           -- minutes after clinic midnight
  end_min         INTEGER NOT NULL,
  visit_type      TEXT NOT NULL CHECK (visit_type IN ('in-person','video')),
  patient_name    TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  note            TEXT,
  is_returning    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  source          TEXT NOT NULL DEFAULT 'website',
  manage_token    TEXT NOT NULL,              -- sha256 of the patient's manage link token
  consent_contact INTEGER NOT NULL DEFAULT 0,
  staff_note      TEXT,
  cancel_reason   TEXT,
  reminded_24h    INTEGER NOT NULL DEFAULT 0,
  reminded_2h     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS bookings_phone ON bookings(phone);

CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL,
  reason     TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS blocks_date ON blocks(date);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  email      TEXT,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  password_hash TEXT NOT NULL,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  booking_ref TEXT,
  kind        TEXT NOT NULL,       -- confirmation, reminder_24h, cancellation, admin_alert …
  channel     TEXT NOT NULL,       -- whatsapp, email, log
  recipient   TEXT,
  status      TEXT NOT NULL,       -- sent, failed, skipped
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT NOT NULL,        -- 'patient', 'system' or the admin's email
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function audit(db, actor, action, target, detail) {
  db.prepare('INSERT INTO audit_log (actor, action, target, detail) VALUES (?,?,?,?)')
    .run(actor, action, target ?? null, detail == null ? null : JSON.stringify(detail));
}
