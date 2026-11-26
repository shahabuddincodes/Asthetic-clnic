import { settings } from "./config.js";
import { openDb } from "./db.js";
import { createNotifier } from "./notify.js";
import { createApp } from "./app.js";
import { startReminderLoop } from "./reminders.js";

const db = openDb(settings.databaseFile);
const notifier = createNotifier(db);
const app = createApp({ db, notifier });

const server = app.listen(settings.port, () => {
  const n = db.prepare("SELECT COUNT(*) n FROM admins").get().n;
  console.log(
    `Clinic API on http://localhost:${settings.port}/api  (db: ${settings.databaseFile})`,
  );
  if (!n)
    console.log(
      "No staff accounts yet — create one with:  npm run create-admin",
    );
  const channels = [
    settings.notify.whatsappToken && "WhatsApp",
    settings.notify.smtpUrl && "email",
  ].filter(Boolean);
  console.log(
    `Notifications: ${channels.length ? channels.join(" + ") : "console only (set WHATSAPP_* or SMTP_URL in .env)"}`,
  );
});
const stopReminders = settings.remindersEnabled
  ? startReminderLoop(db, notifier)
  : () => {};

function shutdown() {
  stopReminders();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
