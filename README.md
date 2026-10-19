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
- **Text messages (Twilio).** Customers who tick "Text me" when booking get a confirmation, reminders (24h and 2h before by default; configurable), and notices when something changes. They can reply:
  - **C** to confirm they'll come (the booking shows "✓ customer confirmed").
  - **R** to get three new times, then **1**, **2** or **3** to move to one.
  - **X** to cancel (within the cancellation policy, with an automatic refund).
  - Anything else goes to the AI assistant, if the business has it on ("can I come Thursday at 4 instead?").

  Admins get a text when customers book, confirm, reschedule or cancel, plus an optional morning agenda. Staff can get an "up next" text before each appointment. Admins can text **TODAY** or **TOMORROW** for their schedule, or (on AI plans) ask in plain words to move or cancel bookings. STOP/START opt-outs are respected. Each plan includes a monthly text allowance that you set as super admin.
- **Refunds.** Full or partial, from the admin bookings screen, the payments list, the super admin payments list, or the mobile admin. If a customer cancels online within the policy window, they're refunded automatically.

## Try it online

### Option 1: a public test website on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dher405/Personal/tree/slotwise)

1. Click the button and sign in to Render with GitHub. Allow Render to access the `Personal` repository when asked.
2. Enter a **SUPERADMIN_EMAIL** and **SUPERADMIN_PASSWORD** (your platform login). Leave the optional keys blank for now.
3. Click **Apply**. The first build takes about 3–5 minutes. Your site will be at `https://slotwise-xxxx.onrender.com` (shown at the top of the service page).
4. Log in with your super admin account, or as the demo business: `owner@demo.test` / `demo1234`.

What to know about the free test setup (`render.yaml`):
- It runs in **demo mode**: the sample business is created automatically, payments are test mode (no real money), and texts are simulated (see Admin → Text messages).
- The free plan **sleeps after 15 minutes without visitors**; the first visit after that takes about a minute to wake it.
- The free plan's **data is wiped on every restart or redeploy**; the demo data comes back each time. To keep data, switch the service to the Starter plan and add the disk described at the bottom of `render.yaml`.
- The demo business login is public knowledge. Anyone who finds the URL can sign in as it. Fine for testing; remove `DEMO_MODE` before real use.
- Every push to the `slotwise` branch redeploys automatically.
- To turn on the AI chat or real texts, add `ANTHROPIC_API_KEY` or the `TWILIO_*` keys under the service's **Environment** tab.

### Option 2: run it inside GitHub (Codespaces, private to you)

On GitHub, switch to the `slotwise` branch, then click **Code → Codespaces → Create codespace on slotwise**. It installs everything, creates the demo data, starts the app, and opens the website in a new tab (allow pop-ups if it doesn't). Super admin: `super@slotwise.test` / `super1234`. Personal accounts get free Codespaces hours each month; stop the codespace when you're done.

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

Tests: `npm test`. They cover texting (opt-in, reminder timing, C/R/X replies, STOP, admin agenda, plan allowance, Twilio signatures), availability, double booking, payment → confirm → refund, admin moves, price changes and refunds, permissions between businesses, plan limits, the cancellation policy, and the AI tool loop (run against a fake Messages API).

## Turning on the AI assistant

1. Put `ANTHROPIC_API_KEY` in `server/.env`. The model is `claude-opus-5-5` at `AI_EFFORT=low`; both can be changed in `.env`.
2. The business must be on a plan with AI enabled (Pro or Business by default).
3. Turn it on in **Admin → AI assistant**.

Each message from a customer is an API call that you pay for. The public chat is rate-limited per IP (`server/src/lib/rateLimit.ts`). Server-side model fallbacks are enabled, so if a request is declined it is retried on a fallback model instead of failing.

## Booking on a business's own website

Each business gets copy-paste code under **Admin → Add to website**, with a live preview:

```html
<!-- Calendar inside the page (grows to fit, no scrollbar) -->
<script src="https://<your-slotwise>/embed.js" data-business="riverside-music" async></script>
<!-- A button that opens the calendar in a pop-up; data-mode="floating" pins it bottom-right -->
<script src="https://<your-slotwise>/embed.js" data-business="riverside-music" data-mode="button" data-label="Book a lesson" async></script>
```

Options: `data-service` (open on one service), `data-color`, `data-theme="dark"`, `data-header="0"` (hide the name and address), `data-target="#selector"`. Any element with `data-slotwise-open` opens the pop-up. A completed booking fires a `slotwise:booked` event on the host page, for analytics.

- The embed loads `/embed/<slug>`, the booking page without the site header. Payment opens in a new tab, because checkout pages refuse to run inside another site.
- Only `/embed/*` may be framed by other sites. Every other page sends `frame-ancestors 'self'`, so admin screens can't be clickjacked.
- Customers get confirmation, reschedule and cancellation **emails** (via Resend/Postmark) in addition to the optional texts.

## Super admin workspace

The super admin has no separate "Admin" section. **Super admin → Businesses → (a business)** opens the same tabs the business's admins see (Dashboard, Bookings, Services, Staff, Payments, texts, calendars, AI, billing, settings, website). The extra **Account & billing ★** tab shows:
- fees earned, packs bought, and their customers' payments this month
- the plan (set it directly for comped accounts) and links to the business's Stripe customer and subscription
- usage, and free credits you've given
- the business's admins (add, remove, send a reset link)
- suspend or reactivate
- the business's recent activity

Links that point at `/admin/...` (emails, Stripe and calendar redirects) forward to the same page in the workspace.

## Usage-based pricing

Each plan includes a monthly allowance of **online bookings**, **text messages** and **AI assistant messages**, plus a staff limit and a fee on online payments. The super admin edits all of this in **Plans & fees**, along with the top-up **packs** businesses can buy.

- **What counts:** online bookings (web, app, AI chat) count once they're confirmed, which for paid bookings means once payment completes. Bookings an admin enters never count. Texts count when sent (customer texts and the business's own alerts). AI counts one per message the assistant answers.
- **When it runs out:** that feature pauses until the business adds more. Online booking shows customers a "please call" notice, texts are skipped (and logged), and AI chat is hidden. Meters reset on the 1st of each month (UTC).
- **Tracker:** usage bars on the business's Dashboard and Plan & billing page, and per business in Super admin → Businesses.
- **Alerts:** every admin of the business is emailed once per meter per month at 80% and at 100%. The email offers the right pack, the next plan that includes more, and auto top-up.
- **Packs:** paid through Stripe Checkout (`checkout.session.completed` with `metadata.kind = usage_pack`), and they apply to the current month. **Auto top-up** adds the smallest pack the moment a meter runs out and puts it on the business's next subscription invoice (a Stripe invoice item). It needs a card on file. The super admin can also **Give credits** for free.

## Calendars

**Customers.** After booking, and on their manage page, customers get **Add to calendar** buttons: Google Calendar, Outlook.com, Outlook work/school, and an `.ics` file for Apple Calendar and everything else. Every booking email carries a calendar invitation. It keeps the same UID and a rising SEQUENCE, so Gmail, Outlook and Apple Mail move the existing entry when the booking is rescheduled and remove it when it's cancelled.

**Business owners and staff (Admin → Calendar sync).**
- **Connect Google Calendar or Outlook** per staff member, using OAuth with offline access; tokens are stored encrypted.
  - Bookings are written to that calendar the moment they're made, moved or cancelled, with a popup reminder at the chosen time.
  - Busy events in that calendar block those times on the booking page. Events marked free, cancelled events, and Slotwise's own events don't block. Results are cached for 60 seconds, and if a calendar can't be read, times stay bookable and the error is shown.
  - Changes made inside Google/Outlook do *not* flow back; the event description says so.
- **Subscribe link** (read-only `.ics` feed, whole business or per person). Works with any calendar app with no account connection, but calendar apps refresh feeds only every few hours.
- **Email alerts** to every admin when customers book, confirm, reschedule or cancel.

**Setup.**
- **Google:** in the same Google Cloud project as sign-in, enable the **Google Calendar API**. Add the scope `.../auth/calendar.events` to the OAuth consent screen, and add the redirect URI `https://<your-site>/api/integrations/google/callback`. Google requires app verification for this scope before the general public can use it; up to 100 test users work before that.
- **Microsoft:** in the [Azure portal](https://portal.azure.com) → App registrations → New registration, choose "Accounts in any organizational directory and personal Microsoft accounts".
  1. Add a Web redirect URI: `https://<your-site>/api/integrations/microsoft/callback`.
  2. Under API permissions, add delegated `Calendars.ReadWrite`, `User.Read` and `offline_access`.
  3. Create a client secret.
  4. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

## Sign-in, password resets, Google and Apple

- **Forgot password:** the sign-in page has a "Forgot password?" link. People enter their email and get a single-use link that expires in 1 hour. Using it signs them out on every other device. The reply is the same whether or not the email has an account, so the form can't be used to find out who's registered.
- **Super admin:** **Super admin → Users** shows how each person signs in (password, Google, Apple) and which businesses they manage. **Send reset link** emails them a link and also shows it to you to copy, which works even before email is set up. **Set password** sets one directly. Both sign them out everywhere.
- **Account page:** anyone signed in can change their password there. People who joined with Google/Apple can add a password.
- **Google/Apple accounts:** a Google or Apple account whose *verified* email matches an existing account is linked to it, so admins keep their businesses. New people get a customer account. Choosing "List your business" with Google/Apple takes them to a short "Set up your business" step.

**Email (needed for reset emails).** Create a free [Resend](https://resend.com) account, verify your sending domain, and set `RESEND_API_KEY` and `EMAIL_FROM` (Postmark also works: `POSTMARK_SERVER_TOKEN`). Until then, reset links are only written to the server log. On Render that's the **Logs** tab; you can also use **Send reset link** above.

**Google button.** In [Google Cloud Console](https://console.cloud.google.com) → APIs & Services:
1. Set up the **OAuth consent screen** (External; app name, support email, your domain).
2. Under **Credentials → Create credentials → OAuth client ID**, choose *Web application* and add the authorized redirect URI `https://<your-site>/api/auth/oauth/google/callback`.
3. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

While the consent screen is in "Testing", only the test users you list can sign in. Click **Publish app** when you're ready for everyone.

**Apple button** (needs a paid Apple Developer account, $99/year, and an HTTPS site; it can't run on localhost). At [developer.apple.com](https://developer.apple.com/account/resources) → Certificates, IDs & Profiles:
1. Under **Identifiers**, make sure your App ID has *Sign in with Apple* enabled.
2. Create a **Services ID** (e.g. `com.yourcompany.slotwise.web`), enable *Sign in with Apple*, then **Configure**: add your domain and the return URL `https://<your-site>/api/auth/oauth/apple/callback`.
3. Under **Keys**, create a key with *Sign in with Apple* and download the `.p8` file (you can only download it once).
4. Set `APPLE_SERVICES_ID`, `APPLE_TEAM_ID` (top right of the developer site), `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (the .p8 contents).

People who choose "Hide my email" get an `@privaterelay.appleid.com` address. To email them, register your sending domain under **Sign in with Apple for Email Communication** in Apple's developer site.

On Render, add these keys under the service's **Environment** tab and it redeploys. The buttons appear automatically once their keys are set.

## Setting up text messages (Twilio)

Without Twilio settings, texts are **simulated**: they show up in **Admin → Text messages → Message log**, and the "Try a reply" box there lets you pretend to be a customer texting back. That's enough to try every flow locally.

To send real texts:
1. In Twilio, buy a number and create a **Messaging Service** containing it. The service handles STOP/HELP automatically.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`) in `server/.env`.
3. On the Messaging Service, set the incoming message webhook to `https://<your-api>/api/webhooks/twilio/sms` (HTTP POST). Delivery statuses come back to `/api/webhooks/twilio/status` automatically. Both check Twilio's signature, so `PUBLIC_API_URL` must exactly match the public URL Twilio calls.
4. **US numbers must be registered** before carriers will deliver: register your brand and campaign through **A2P 10DLC** in the Twilio console, or use a verified toll-free number. Registration takes days to weeks, so start early. Describe the use case as appointment confirmations and reminders with two-way replies.
5. Each business turns texting on under **Admin → Text messages** and enters their own mobile number for alerts. Staff mobile numbers go under **Staff & hours**.

All businesses share one platform number. When a customer replies, it's matched to the booking from the most recent text that customer received.

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
| Admin (per business) | `/api/admin/:bid` → settings, `/sms`, `/sms/test`, `/sms/simulate`, `/bookings/:id/sms-reminder`, `/services`, `/staff`, `/staff/:id/hours`, `/staff/:id/time-off`, `/bookings`, `/slots`, `/payments`, `/payments/:id/refund`, `/payment-provider`, `/billing/checkout`, `/billing/portal`, `/assistant`, `/stats`, `/audit` |
| Super admin | `/api/super/overview`, `/businesses`, `/businesses/:id/members`, `/users`, `/plans`, `/payments`, `/audit` |
| Payments | `/api/payments/:id/return`, `/api/payments/sync/:token`, `/api/webhooks/{stripe,square,paypal}` |
| SMS | `/api/webhooks/twilio/sms` (incoming texts), `/api/webhooks/twilio/status` (delivery status), `POST /api/public/manage/:token/confirm` |

## Before launching for real

- [ ] Run on a host with HTTPS (Render, Fly.io, Railway, AWS). Set `NODE_ENV=production`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `PUBLIC_WEB_URL`, and `PUBLIC_API_URL`. Serve `web/dist` from a CDN or static host.
- [ ] **Database.** SQLite is fine for one server. To run several, move to Postgres; all SQL goes through `server/src/db.ts`.
- [ ] **Email confirmations.** Texts go through Twilio; email in `server/src/lib/notify.ts` still only logs. Connect a provider such as Postmark or SendGrid.
- [ ] **Twilio live setup and A2P 10DLC (or toll-free) registration**, as described above. Texts sent before registration will be blocked by US carriers.
- [ ] **Email provider** (Resend or Postmark) so password-reset emails are delivered.
- [ ] Switch Stripe, Square, and PayPal to live keys and register the webhooks above. Apply for PayPal Commerce Platform if you want PayPal fees.
- [ ] Terms of service, privacy policy, and refund policy pages. Your payment providers' platform agreements will ask for these.
- [ ] Use a shared rate-limit store (Redis) if you run more than one API instance.
- [ ] Currencies are assumed to have 2 decimal places. Zero-decimal currencies such as JPY need adjusting in `payments/types.ts`.
