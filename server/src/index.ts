import { config } from "./config.js";
import { createApp } from "./app.js";
import { expireUnpaidBookings } from "./lib/bookings.js";
import { runReminders } from "./lib/reminders.js";
import { runSeriesReminders } from "./lib/series.js";
import { seed } from "./seed.js";
import { db } from "./db.js";
import { storageStatus } from "./lib/storage.js";
import { syncStripeMode } from "./lib/stripeMode.js";
import { clearShowcaseBookings } from "./lib/showcase.js";
import { startMarketingScheduler } from "./marketing/scheduler.js";

const storage = storageStatus();
console[storage.persistent === false ? "warn" : "log"](`${storage.persistent === false ? "WARNING: " : ""}${storage.message}`);

// Demo deployments start with the sample business and logins (safe to re-run).
if (config.demoMode) await seed();
// Moving between Stripe test and live keys (also when the key is changed in Render's environment).
syncStripeMode();

const server = createApp().listen(config.port, () => {
  console.log(`Slotwise listening on port ${config.port} (public URL ${config.webUrl})`);
});

// Render stops the old instance with SIGTERM on every deploy and restart: finish requests in flight,
// then close the database so its write-ahead log is folded back into the file.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => { db.close(); process.exit(0); }, 10_000).unref();
  });
}

// Release slots held by abandoned checkouts.
setInterval(() => {
  const n = expireUnpaidBookings();
  if (n) console.log(`Expired ${n} unpaid booking(s)`);
}, 5 * 60_000).unref();

// Visitors' bookings on the home page showcase are cleared a few hours later.
setInterval(() => {
  const n = clearShowcaseBookings();
  if (n) console.log(`Cleared ${n} showcase booking(s)`);
}, 30 * 60_000).unref();

// Repeating lessons: "continue for another 26 weeks?" two weeks before a series ends.
setInterval(() => {
  runSeriesReminders().catch((err) => console.error("series reminders failed", err));
}, 60 * 60_000).unref();

// Text reminders, staff "up next" texts and the admin's morning agenda.
setInterval(() => {
  runReminders().catch((err) => console.error("reminder run failed", err));
}, 60_000).unref();

// Marketing agent (Super admin → Marketing): does nothing until it's switched on in its Settings.
startMarketingScheduler();
