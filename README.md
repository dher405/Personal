# Slotwise

An online booking platform in the style of Booksy. Businesses (salons, tutors, music teachers, trainers) publish their services and open times. Customers book on the web, in the mobile app, or by chatting with an AI assistant. The platform owner charges businesses a subscription and/or a fee on each payment.

```
slotwise/
├── server/   Node + Express + TypeScript API (SQLite via node:sqlite)
├── web/      React + Vite: public booking pages, admin screen, super admin console
└── mobile/   Expo (React Native) app for iOS and Android
```

## Who can do what

| Role | How they get it | What they can do |
|---|---|---|
| **Super admin** (you) | `SUPERADMIN_EMAIL` + `npm run seed`, or promoted by another super admin | Everything below, for every business. Set plan prices and per-payment fees, suspend businesses, change a business's plan by hand, add admins to a business, change user roles, reset passwords, refund any payment, view the platform-wide audit log. |
| **Admin** (a business owner or manager) | Signs up with "I want to offer services", or gets added by a super admin | Manage their own businesses: services and prices, staff and weekly hours, time off, bookings (create, move, change price, cancel, mark completed or no-show), refunds (full or partial), payment provider, AI assistant settings, their own plan and billing. |
| **Customer** | Signs up, or books as a guest | Book, pay, reschedule, and cancel through a private manage link or the AI chat. |

Every change to a booking, price, refund, or plan is written to an audit log, along with who made it (person, AI assistant, or payment webhook).

## Features

- **Calendar and availability.** Each staff member has weekly hours and time off. Each service has a duration, a buffer after it, a price, and an optional deposit. Businesses also set the slot interval, minimum notice, how far ahead customers can book, and a cancellation window. A slot is only offered if the whole appointment plus its buffer fits and doesn't overlap another booking. Double booking is blocked in a database transaction.
- **Booking channels.** Web booking page at `/b/<slug>`, the mobile app, the AI chat, and admin-created bookings. Admins can override availability (for example, to squeeze someone in) and set a custom price per booking.
- **AI booking assistant** (Claude, optional, per business):
  - *Customer chat* on the booking page and in the app. It lists services, finds real open times, books, reschedules, and cancels. To change an existing booking it needs the booking code plus the email used to book. The owner can add custom instructions such as "new students start with the trial lesson".
  - *Admin assistant* in the admin screen, for requests like "what's on tomorrow?", "move Jo to Friday at 3", "block Alex off Monday", or "raise the 60-minute lesson to $80".
  - The AI can't issue refunds. Moving money is always a person's decision.
- **Customer payments** go straight into the business's own account through hosted checkout pages, so card details never reach your server:
  - **Stripe** (Stripe Connect Express, with your platform fee taken as an application fee)
  - **Square** (payment links)
  - **PayPal** (Orders v2, with platform fees through PayPal's partner program)
  - **Test mode** (fake payments for development)
  - Unpaid bookings hold their slot for 30 minutes and are then released.
- **Platform billing** (how you get paid):
  - Monthly plans billed through *your* Stripe account (Stripe Billing, with a customer portal for invoices and cards).
  - A percentage fee on each online customer payment, set per plan.
  - Plans also set the staff limit and whether AI is included. The super admin edits all of this in **Super admin → Plans & fees**.
- **Refunds.** Full or partial, from the admin bookings screen, the payments list, the super admin payments list, or the mobile admin. If a customer cancels online within the policy window, they're refunded automatically.

## Quick start (local)

Needs Node 22.13 or later.

```bash
npm install                    # server + web (npm workspaces)
cp server/.env.example server/.env
npm run seed --workspace server
npm run dev                    # API on :4000, web on :5173
```

Open http://localhost:5173.

| Login | Password | What you'll see |
|---|---|---|
| `super@slotwise.test` (or your `SUPERADMIN_EMAIL`) | `super1234` (or `SUPERADMIN_PASSWORD`) | Super admin console |
| `owner@demo.test` | `demo1234` | Admin screen for the demo "Riverside Music" business |

The demo business uses **test mode** payments, so you can run the whole flow (book → pay → refund) without any payment account.

Tests: `npm test`. They cover availability, double booking, payment → confirm → refund, admin moves, price changes and refunds, permissions between businesses, plan limits, the cancellation policy, and the AI tool loop (run against a fake Messages API).

## Turning on the AI assistant

1. Put `ANTHROPIC_API_KEY` in `server/.env`. The model is `claude-opus-5-5` at `AI_EFFORT=low`; both can be changed in `.env`.
2. The business must be on a plan with AI enabled (Pro or Business by default).
3. Turn it on in **Admin → AI assistant**.

Each message from a customer is an API call that you pay for. The public chat is rate-limited per IP (`server/src/lib/rateLimit.ts`). Server-side model fallbacks are enabled, so if a request is declined it is retried on a fallback model instead of failing.

## Setting up payments

### Stripe (recommended; also bills your subscriptions)
1. Create a Stripe account and enable **Connect** (Express accounts).
2. Set `STRIPE_SECRET_KEY` in `server/.env`.
3. Add a webhook endpoint `https://<your-api>/api/webhooks/stripe` that listens to **both** your own account and **connected accounts**, with these events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Enable the customer portal under Stripe → Settings → Billing → Customer portal.
5. Businesses pick **Stripe** in Admin → Payments and are sent to Stripe to finish onboarding.

Locally: `stripe listen --forward-to localhost:4000/api/webhooks/stripe --forward-connect-to localhost:4000/api/webhooks/stripe`.

If `STRIPE_SECRET_KEY` isn't set, plan changes apply right away with no charge. This is useful for development.

### Square
- Each business pastes its Square **access token** and **location ID** in Admin → Payments. They're encrypted at rest with `APP_ENCRYPTION_KEY`.
- Set `SQUARE_ENV=production` when you go live.
- Webhook: `https://<your-api>/api/webhooks/square` for `payment.updated`, with `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` set. Payments are also checked when the customer returns from checkout.
- Platform fees on Square only work if businesses connect through **Square OAuth** (your Square app). With pasted personal tokens, no fee is collected.

### PayPal
- Create a PayPal REST app and set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_ENV=live`.
- Each business enters its **merchant ID**.
- Webhook: `https://<your-api>/api/webhooks/paypal` for `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED`; set `PAYPAL_WEBHOOK_ID`.
- Taking a platform fee (`platform_fees`) requires approval for **PayPal Commerce Platform**. Without it, leave the fee at 0% for PayPal businesses, or bill them through the subscription instead.

## Mobile app

```bash
cd mobile
npm install
cp .env.example .env     # EXPO_PUBLIC_API_URL=http://<your computer's LAN IP>:4000
npx expo start           # scan the QR code with Expo Go
```

The app covers searching for businesses, booking with a day and time picker, paying through the provider's checkout page, AI chat booking, sign-in, "my bookings", and a mobile admin. The mobile admin shows the next 14 days of bookings and lets you move them, change prices, mark completed or no-show, cancel, and refund. The full setup screens (services, hours, payments, plans) are on the web admin.

To publish to the App Store and Google Play, use EAS: `npx eas build` then `npx eas submit` (needs Apple and Google developer accounts).

## API overview

| Area | Routes |
|---|---|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `GET /api/auth/my-bookings` |
| Public | `GET /api/public/businesses[/:slug]`, `GET …/:slug/slots`, `POST …/:slug/bookings`, `POST …/:slug/chat` |
| Customer self-service | `GET /api/public/manage/:token`, `POST …/reschedule`, `…/cancel`, `…/pay` |
| Admin (per business) | `/api/admin/:bid` → settings, `/services`, `/staff`, `/staff/:id/hours`, `/staff/:id/time-off`, `/bookings`, `/slots`, `/payments`, `/payments/:id/refund`, `/payment-provider`, `/billing/checkout`, `/billing/portal`, `/assistant`, `/stats`, `/audit` |
| Super admin | `/api/super/overview`, `/businesses`, `/businesses/:id/members`, `/users`, `/plans`, `/payments`, `/audit` |
| Payments | `/api/payments/:id/return`, `/api/payments/sync/:token`, `/api/webhooks/{stripe,square,paypal}` |

## Before launching for real

- [ ] Run on a host with HTTPS (Render, Fly.io, Railway, AWS). Set `NODE_ENV=production`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `PUBLIC_WEB_URL`, and `PUBLIC_API_URL`. Serve `web/dist` from a CDN or static host.
- [ ] **Database.** SQLite is fine for one server. To run several, move to Postgres; all SQL goes through `server/src/db.ts`.
- [ ] **Email/SMS confirmations and reminders.** `server/src/lib/notify.ts` only logs right now. Connect a provider such as Postmark, SendGrid, or Twilio.
- [ ] **Password reset by email.** Not built yet; for now a super admin resets passwords.
- [ ] Switch Stripe, Square, and PayPal to live keys and register the webhooks above. Apply for PayPal Commerce Platform if you want PayPal fees.
- [ ] Terms of service, privacy policy, and refund policy pages. Your payment providers' platform agreements will ask for these.
- [ ] Use a shared rate-limit store (Redis) if you run more than one API instance.
- [ ] Currencies are assumed to have 2 decimal places. Zero-decimal currencies such as JPY need adjusting in `payments/types.ts`.
