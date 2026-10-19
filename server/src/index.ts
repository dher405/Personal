import { config } from "./config.js";
import { createApp } from "./app.js";
import { expireUnpaidBookings } from "./lib/bookings.js";
import { runReminders } from "./lib/reminders.js";
import { seed } from "./seed.js";

// Demo deployments start with the sample business and logins (safe to re-run).
if (config.demoMode) await seed();

createApp().listen(config.port, () => {
  console.log(`Slotwise listening on port ${config.port} (public URL ${config.webUrl})`);
});

// Release slots held by abandoned checkouts.
setInterval(() => {
  const n = expireUnpaidBookings();
  if (n) console.log(`Expired ${n} unpaid booking(s)`);
}, 5 * 60_000).unref();

// Text reminders, staff "up next" texts and the admin's morning agenda.
setInterval(() => {
  runReminders().catch((err) => console.error("reminder run failed", err));
}, 60_000).unref();
