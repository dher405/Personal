import { newId, one, run } from "./db.js";
import { hashPassword } from "./lib/auth.js";
import { encryptJson } from "./lib/crypto.js";
import { createBusiness } from "./routes/auth.js";
import { saveChannels } from "./lib/channels.js";

/** Creates (or promotes) the super admin and a demo business you can book against. Safe to re-run. */
export async function seed() {
  const superEmail = process.env.SUPERADMIN_EMAIL ?? "super@slotwise.test";
  const superPassword = process.env.SUPERADMIN_PASSWORD ?? "super1234";
  const existing = one("SELECT id FROM users WHERE email = ?", superEmail);
  if (existing) run("UPDATE users SET role = 'superadmin' WHERE id = ?", existing.id);
  else run("INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?, 'superadmin')", newId("usr"), superEmail, await hashPassword(superPassword), "Platform Owner");

  const demo = one("SELECT id, comms_config FROM businesses WHERE slug = 'riverside-music'");
  if (demo) {
    // Demo businesses made before businesses had their own channels: texts in test mode, so they still show in the log.
    if (!demo.comms_config) saveChannels(demo.id, { email: { provider: "none" }, sms: { provider: "test" } });
    return { superEmail };
  }

  const ownerId = newId("usr");
  run("INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?, 'admin')", ownerId, "owner@demo.test", await hashPassword("demo1234"), "Dana Rivers");
  const biz = createBusiness(ownerId, "Riverside Music");
  run(
    `UPDATE businesses SET slug = 'riverside-music', category = 'Music lessons', description = ?, address = '12 River St, Hudson, NY',
       phone = '(555) 010-2020', plan = 'pro', ai_enabled = 1, payment_provider = 'mock', require_payment = 1, payment_config = ?,
       sms_enabled = 1, sms_admin_phone = '+15550102020', sms_agenda_hour = 7, sms_staff_reminder_min = 60 WHERE id = ?`,
    "Private piano, guitar and voice lessons for all ages.", encryptJson({}), biz.id,
  );
  // Texts in test mode (shown in the message log, never sent). Customer email stays off until the owner connects their own account.
  saveChannels(biz.id, { email: { provider: "none" }, sms: { provider: "test" } });

  const staff = [
    { id: newId("stf"), name: "Alex Kim", phone: "+15550103030", bio: "Piano & music theory, 12 years teaching." },
    { id: newId("stf"), name: "Sam Ortiz", phone: "+15550104040", bio: "Guitar and voice. Rock, folk and jazz." },
  ];
  for (const s of staff) {
    run("INSERT INTO staff (id, business_id, name, phone, bio) VALUES (?,?,?,?,?)", s.id, biz.id, s.name, s.phone, s.bio);
    for (const weekday of [1, 2, 3, 4, 5]) run("INSERT INTO availability_rules (id, staff_id, weekday, start_time, end_time) VALUES (?,?,?,?,?)", newId("avl"), s.id, weekday, "09:00", "17:00");
    run("INSERT INTO availability_rules (id, staff_id, weekday, start_time, end_time) VALUES (?,?,?,?,?)", newId("avl"), s.id, 6, "10:00", "14:00");
  }

  const services = [
    { name: "Piano lesson (30 min)", category: "Piano", duration: 30, price: 4000, staff: [0] },
    { name: "Piano lesson (60 min)", category: "Piano", duration: 60, price: 7500, staff: [0] },
    { name: "Guitar lesson (45 min)", category: "Guitar", duration: 45, price: 5500, staff: [1] },
    { name: "Voice lesson (45 min)", category: "Voice", duration: 45, price: 5500, staff: [1] },
    { name: "Free trial lesson", category: "Intro", duration: 20, price: 0, staff: [0, 1] },
  ];
  for (const s of services) {
    const id = newId("svc");
    run("INSERT INTO services (id, business_id, name, category, duration_min, buffer_min, price_cents) VALUES (?,?,?,?,?,?,?)", id, biz.id, s.name, s.category, s.duration, 10, s.price);
    for (const i of s.staff) run("INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)", staff[i].id, id);
  }
  return { superEmail, demoOwner: "owner@demo.test / demo1234", slug: "riverside-music" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => console.log("Seeded:", r));
}
