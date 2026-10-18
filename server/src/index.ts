import { config } from "./config.js";
import { createApp } from "./app.js";
import { expireUnpaidBookings } from "./lib/bookings.js";

createApp().listen(config.port, () => {
  console.log(`Slotwise API listening on ${config.apiUrl}`);
});

// Release slots held by abandoned checkouts.
setInterval(() => {
  const n = expireUnpaidBookings();
  if (n) console.log(`Expired ${n} unpaid booking(s)`);
}, 5 * 60_000).unref();
