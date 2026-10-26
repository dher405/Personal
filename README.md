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
  - The AI can't issue partial refunds, and it checks with the admin before cancelling a paid booking (cancelling refunds in full).
- **Customer payments** go into each business's *own* Stripe, Square or PayPal account (its keys, entered on its Payments tab) through hosted checkout pages, so card details never reach your server. The platform takes nothing from these payments.
  - **Stripe** (Checkout), **Square** (payment links), **PayPal** (Orders v2), or **Test mode** (fake payments for development).
  - Unpaid bookings hold their slot for 30 minutes and are then released.
- **Platform billing** (how you get paid): businesses pay for a monthly number of bookings.
  - Monthly plans billed through *your* Stripe account (Stripe Billing, with a customer portal for invoices and cards), plus booking packs or auto top-ups when they need more.
  - Plans also set AI messages included, the staff limit, and whether AI is included. The super admin edits all of this in **Super admin → Plans & fees**.
- **Text messages (the business's own Twilio account).** Customers who tick "Text me" when booking get a confirmation, reminders (24h and 2h before by default; configurable), and notices when something changes. They can reply:
  - **C** to confirm they'll come (the booking shows "✓ customer confirmed").
  - **R** to get three new times, then **1**, **2** or **3** to move to one.
  - **X** to cancel (within the cancellation policy, with an automatic refund).
  - Anything else goes to the AI assistant, if the business has it on ("can I come Thursday at 4 instead?").

  Admins get a text when customers book, confirm, reschedule or cancel, plus an optional morning agenda. Staff can get an "up next" text before each appointment. Admins can text **TODAY** or **TOMORROW** for their schedule, or (on AI plans) ask in plain words to move or cancel bookings. STOP/START opt-outs are respected. Businesses pay Twilio for their own texts; Slotwise doesn't meter them.
- **Repeating bookings.** A booking can repeat every week or every 2 weeks for a block of weeks (26 by default; each business can choose 4–52 under Settings). Each lesson is its own booking. Weeks that aren't free are skipped and listed. The customer gets one summary email with a single calendar file. Two weeks before the last lesson, the customer is emailed a one-click renewal link (`/manage/<token>?renew=1`) and the business is told. Customers can choose it on the booking page only when the business allows it and doesn't take payment online; admins can set it up from **+ New booking** at any time. Lessons count toward the booking allowance in the month they happen.
- **Refunds.** Cancelling a booking refunds what the customer paid, in full and automatically, whoever cancels (customers can only cancel online within the cancellation window). Moving a booking never refunds. A refund the provider refuses leaves the booking cancelled with a "refund failed" note. Partial refunds are made by hand from the bookings screen, the payments list, the super admin payments list, or the mobile admin.
- **Suspending, closing and deleting a business** (super admin). **Suspend** hides it and pauses its Stripe subscription (invoices are voided, so it isn't charged); reactivating resumes both. **Close** cancels the subscription now, cancels every upcoming booking with a full refund and an email to each customer, and hides the business. A closed business can then be **deleted permanently**.

## Try it online

### Option 1: a public test website on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dher405/Personal/tree/slotwise)

1. Click the button and sign in to Render with GitHub. Allow Render to access the `Personal` repository when asked.
2. Enter a **SUPERADMIN_EMAIL** and **SUPERADMIN_PASSWORD** (your platform login). Leave the optional keys blank for now.
3. Click **Apply**. The first build takes about 3–5 minutes. Your site will be at `https://slotwise-xxxx.onrender.com` (shown at the top of the service page).
4. Log in with your super admin account, or as the demo business: `owner@demo.test` / `demo1234`.

What to know about the free test setup (`render.yaml`):
- It runs in **demo mode**: the sample business is created automatically, payments are test mode (no real money), and the sample business texts in test mode (see Admin → Text messages). Customer emails are off until a business connects its email account (Admin → Email).
- The free plan **sleeps after 15 minutes without visitors**; the first visit after that takes about a minute to wake it.
- **Keeping data:** everything (bookings, every business's settings and keys, your platform settings) is in one SQLite file, which must be on a **persistent disk**. `render.yaml` uses a paid instance (`starter`) with a 1 GB disk at `/var/data` and `DATABASE_PATH=/var/data/slotwise.db`. Without the disk, Render wipes the file on every restart and deploy. **Super admin → Overview** says whether data is on a persistent disk, and the server log says the same at startup. If `DATABASE_PATH` points at a folder that doesn't exist (disk not attached), the server refuses to start rather than silently using a temporary file. Render takes daily snapshots of disks. Never change `APP_ENCRYPTION_KEY` once set: saved keys and passwords are encrypted with it.
- The demo business login is public knowledge. Anyone who finds the URL can sign in as it. Fine for testing; remove `DEMO_MODE` before real use.
- Every push to the `slotwise` branch redeploys automatically.
- To turn on the AI chat, add `ANTHROPIC_API_KEY` under **Super admin → Settings**. Real texts and customer emails are set up by each business on its own Text messages and Email tabs.

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
- Customers get confirmation, reschedule and cancellation **emails** from the business's own address (Admin → Email), in addition to the optional texts.

## Settings pages (no environment variables needed)

**Super admin → Settings** holds the platform's own keys: Stripe (for billing businesses), email to business owners (Resend/Postmark), Anthropic, Google, Microsoft and Apple. Each business sets up its own customer channels: payments (Payments tab), email (Email tab) and texts (Text messages tab).
- Each section shows the exact webhook or redirect URLs to paste into that provider, and most have a **Test connection** button.
- Values are stored encrypted with `APP_ENCRYPTION_KEY`, only the last 4 characters are ever shown, and changes apply immediately.
- A value saved there overrides the environment variable of the same name, so existing Render setups keep working.
- Only `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `DATABASE_PATH` and the site URL stay in the environment. **Saved settings live in the database, so use a persistent disk.**

**Business → Payments** lets each business choose how it's paid:
- **Stripe:** its own secret key and webhook signing secret.
- **Square:** access token, location ID, environment, and an optional webhook signature key.
- **PayPal:** its own PayPal REST app (client ID, secret, environment, webhook ID).

Each business gets its own webhook address (`/api/webhooks/{stripe,square,paypal}/<businessId>`), checked with its own secret, and a **Test connection** button.

## Super admin workspace

The super admin has no separate "Admin" section. **Super admin → Businesses → (a business)** opens the same tabs the business's admins see (Dashboard, Bookings, Services, Staff, Payments, texts, calendars, AI, billing, settings, website). The extra **Account & billing ★** tab shows:
- their plan price, packs bought, and their customers' payments this month
- the plan (set it directly for comped accounts) and links to the business's Stripe customer and subscription
- usage, and free credits you've given
- the business's admins (add, remove, send a reset link)
- suspend or reactivate
- the business's recent activity

Links that point at `/admin/...` (emails, Stripe and calendar redirects) forward to the same page in the workspace.

## Usage-based pricing

Businesses pay by the number of bookings they take. Each plan includes a monthly allowance of **bookings** and **AI assistant messages**, plus a staff limit. (Texts aren't metered: each business sends them through its own Twilio account.) There is no fee on customer payments. The super admin edits all of this in **Plans & fees**, along with the top-up **packs** businesses can buy.

- **What counts:**
  - **Bookings:** every booking (online, app, AI chat, or entered by the business) counts once it's confirmed; for an online booking that requires payment, that means once payment completes. A booking that's later cancelled still counts; an online booking whose payment never completed doesn't.
  - **AI:** counts one per message the assistant answers.
- **When it runs out:** that feature pauses until the business adds more.
  - New bookings pause: customers see a "please call" notice, and the business's own booking form says to add more or upgrade.
  - AI chat is hidden.
  - Meters reset on the 1st of each month (UTC).
- **Tracker:** usage bars on the business's Dashboard and Plan & billing page, and per business in Super admin → Businesses.
- **Warnings before the wall:** every admin of the business is emailed once per meter per month at 80%, 90% and 100%, and a banner shows on every admin tab from 80%. The email offers the right pack, the next plan that includes more, and auto top-up.
- **Packs:** paid through Stripe Checkout (`checkout.session.completed` with `metadata.kind = usage_pack`), and they apply to the current month. **Auto top-up** adds the smallest pack the moment a meter runs out and puts it on the business's next subscription invoice (a Stripe invoice item), so it needs a paid plan. The super admin can also **Give credits** for free.

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

## Two-step sign-in and passkeys

Every sign-in on a device that isn't remembered needs a second step. That covers password, Google/Apple and new accounts, on the web and in the mobile app. The second step is a 6-digit code emailed to the account (10 minutes, 5 tries) or a passkey (WebAuthn, via `@simplewebauthn`).
- **Devices.** Each signed-in browser or app is a row in `devices`. The session token carries its id, so signing a device out under **Account → Security** ends that session. "Remember this device" trusts it for 30 days. Changing or resetting a password signs out all other devices. Tokens from before this change stop working, so everyone signs in once more.
- **Passkeys** work on their own ("Sign in with a passkey"; user verification required) or as the second step. They're tied to the domain in `PUBLIC_WEB_URL`. If you move to a new domain (such as bookwithslotwise.com), people add their passkeys again there.
- **Alerts.** A new device signing in emails the account holder. Sign-ins, new devices and passkey changes are written to the audit log.
- **Needs platform email.** Codes go through Resend/Postmark (**Super admin → Settings → Email**). Until that works, two-step sign-in is paused rather than locking everyone out, and the super admin overview shows a red warning. People with a passkey still use it. In demo mode the `…@demo.test` accounts skip the code.

## Customer emails and texts: each business's own accounts

Everything sent to a business's customers goes out through that business's own accounts, so it comes from their address and their number, and they pay their providers directly. Slotwise doesn't meter or bill texts.

**Email (Admin → Email).** The business picks **My email account** (SMTP, with presets for Gmail/Google Workspace, Microsoft 365/Outlook, Zoho, iCloud, Yahoo, or any web host) or **Resend** for a custom domain. Confirmations, changes and cancellations (with calendar invites) are sent from their address, with an optional reply-to. **Send me a test email** sends a real one. The **Email log** lists every customer email with its status: *sent*, *failed* (with the provider's reason) or *not sent* (email isn't set up yet). Gmail needs 2-Step Verification and an app password.

**Texts (Admin → Text messages).** The business connects **its own Twilio account**: Account SID, Auth token, and its Twilio number (or a Messaging Service SID). The tab shows the business's own incoming-message webhook, `https://<your-api>/api/webhooks/twilio/<business id>/sms`, to paste into that number's "A message comes in" setting; delivery statuses come back automatically. Both are checked with that business's auth token, so `PUBLIC_API_URL` must exactly match the public URL Twilio calls. **Check connection** confirms the credentials and that the number belongs to the account.

- Until Twilio is connected, texting is **hidden everywhere**: no "Text me" box on the booking page, website calendar or app, the AI assistant doesn't offer texts, and texting can't be switched on.
- STOP is per business: replying STOP to one business's number doesn't stop texts from another.
- **US numbers must be registered** (A2P 10DLC, or toll-free verification) before carriers deliver. It takes days, so businesses should start early.
- **Test mode** (texts recorded in the Message log, never sent, with a "Try a reply" box) is available locally and in demo mode only.

Emails to business owners (password resets, new-booking alerts, usage and billing alerts) still come from the platform account in **Super admin → Settings → Email**.

## Setting up payments

**Your billing (Stripe).** This is how businesses pay you for plans and booking packs; all of it is entered in **Super admin → Settings → Stripe**.
1. Create and activate a Stripe account (business details and bank account for payouts).
2. Paste the **secret key** (Developers → API keys).
3. Add one webhook: the URL shown in Settings, with events `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. Paste its signing secret.
4. Turn on the customer portal (Stripe → Settings → Billing → Customer portal) so businesses can manage cards and invoices.

Locally: `stripe listen --forward-to localhost:4000/api/webhooks/stripe`. If no Stripe key is set, plan changes and packs apply right away with no charge, which is useful for development.

**Businesses' own payments.** Each business enters its own Stripe, Square or PayPal keys on its **Payments** tab. The tab shows numbered steps, that business's own webhook URL, and a Test connection button. The money goes straight to the business; the platform is not involved. Payments are confirmed when the customer returns from checkout, and the webhook confirms them as a backup.

**Pay-in-person requests.** On its Payments tab, a business that requires payment can tick **Let customers ask to pay in person (cash) instead**. Customers then choose "Pay in person" when booking (web, embed, app, or by asking the AI chat). The booking is created with status `requested`: the slot is held, no checkout is started, the customer gets a "request received" email (no calendar invite yet), and the business gets an email and, if texting is connected, a text, plus a banner on every admin tab. **Accept** (Bookings) makes it a confirmed booking marked "pays in person": it counts toward the plan's bookings then, and the customer gets the normal confirmation with the calendar invite. **Decline** (with an optional note) releases the slot and emails the customer. Customers can cancel their own request at any time; requests nobody answers are released at the appointment time. API: `POST /api/admin/:bid/bookings/:id/accept`, `POST …/decline`.

## Online appointments and meeting links

Each service has a **Where** setting (Services & prices): *in person*, *online*, or *customer chooses* (the booking page, app, AI chat and the admin booking form then ask). Each business picks its meeting tool on the **Online meetings** tab:

| Tool | How the link is made | What the business enters |
|---|---|---|
| Google Meet | A Meet conference on the event in the staff member's connected Google Calendar (`conferenceDataVersion=1`, `hangoutsMeet`) | Nothing; each staff member connects Google Calendar under Calendar sync |
| Microsoft Teams | `isOnlineMeeting` on the event in the staff member's connected Outlook calendar (work/school Microsoft 365 accounts) | Nothing; each staff member connects Outlook |
| Zoom | `POST /users/me/meetings` with the business's Server-to-Server OAuth app; moved with `PATCH`, deleted on cancel | Account ID, Client ID, Client secret |
| RingCentral Video | A bridge (`POST /rcvideo/v2/account/~/extension/~/bridges`, join link `discovery.web`) with the business's JWT-flow app; deleted on cancel | Client ID, Client secret, JWT credential |
| Fixed link | The same link for every online booking | The link |

The link is made before any confirmation goes out (`lib/meetings.ts`, called from `notify`), so it's in the customer's email, calendar invite (as the location), texts and manage page ("Join the online meeting"), and in the owner's calendar. If it can't be made (for example, the staff member hasn't connected their calendar), the booking still confirms, the customer is told the link will follow, and Bookings shows the reason with **Retry** and **Paste link** (which sends the customer an updated confirmation). Provider addresses can be overridden for testing with `ZOOM_OAUTH_URL`, `ZOOM_API_URL` and `RINGCENTRAL_SERVER_URL`.

## "Powered by Slotwise"

Businesses on plans with the **"Powered by" badge** (on for free plans by default; set per plan in **Super admin → Plans & fees**) show a small "Powered by Slotwise" link at the bottom of their booking page, website calendar and booking-management page. It links to the home page with `?ref=powered-by&from=<slug>`. Their customer emails also get a one-line footer (`?ref=email`). The home page demo never shows it.

## Home page demo ("Try it as a customer")

The super admin picks one business as the home page demo: **Super admin → Overview → Home page demo**, or open a business → Account & billing ★ → Status → "Use as the home page demo". **Create the sample "Riverside Music" demo** makes a sample music school owned by the super admin. The home page then shows its live, embedded booking calendar for visitors to try. The demo business is a sandbox:
- payments are test payments, so nothing is charged;
- no emails or texts go out, and its bookings don't count toward an allowance (AI replies still do, which caps that cost);
- visitors' bookings are deleted 3 hours after they're made (`lib/showcase.ts`);
- only the super admin can change its settings.

In production with `DEMO_MODE` off, the sample `…@demo.test` accounts can't sign in.

## Owner guide and support cases

**Owner guide (`/guide`).** The business owner guide is built into the site, with a contents list. Every business's Dashboard and the top of each admin page link to it. Its text is `web/src/content/owner-guide.md`, made from the guide's Claude Docs export with `python3 scripts/import-guide.py <export> --date "<Month D, YYYY>"`. Committing that file publishes the update with the next deploy.

**Support cases.** Businesses open cases from **Contact support** on their Dashboard (or **Help & support** at the top of any admin page): category, subject, description, and a reply-to email. Each case gets a number (`SW-1001`, `SW-1002`, …). The super admin answers under **Super admin → Support** (filter by *Needs reply*, *Waiting on business* or *Resolved*, search by number, business, subject or email). A support reply sets the case to *Waiting on business* (or *Resolved*); a business reply reopens it.
- Everyone is emailed through the platform email account (Settings → Email), with a link back to the case. The business gets a confirmation with its case number and each support reply. The super admin's **Notifications** box (bottom of Support) sets which addresses hear about new cases, business replies and, optionally, copies of support replies, and can send a test email. Until a list is saved, the super admin account is notified.
- **Support assistant (AI).** With an Anthropic key under **Super admin → Settings → Support assistant** (or the AI assistant key) and a model picked there, each new case and each business reply is analysed in the background (`server/src/ai/supportAgent.ts`). The assistant reads the case and checks the business with read-only tools: setup overview, recent bookings, a booking by code, email and text logs, payments, activity log, other cases, known issues. The owner guide is its reference. It records a triage on the case: summary, category, severity, likely cause, notes for the super admin, and a **draft reply that is never sent on its own**. The super admin edits it and clicks **Approve and send** (or discards it, or asks it to look again with an instruction). Businesses never see the assistant's work. Case text is treated as data, not instructions. Bugs, process gaps, guide problems and setup traps go to **Support → Issues found**, de-duplicated across cases; **Copy for Claude Code** produces a bug report to paste into a Claude Code session. Switch off automatic analysis or add standing instructions in the Support tab's Notifications box.
- API: `GET/POST /api/admin/:bid/support`, `GET /api/admin/:bid/support/:cid`, `POST …/:cid/messages`; `GET /api/super/support`, `GET /api/super/support/:cid`, `POST …/:cid/messages`, `GET/PUT /api/super/support/settings`, `POST /api/super/support/settings/test`, `POST /api/super/support/:cid/triage`, `POST …/:cid/draft/send`, `POST …/:cid/draft/discard`, `GET /api/super/support/issues`, `PATCH …/issues/:id`, `GET …/issues/:id/report`.

## Marketing agent

**Super admin → Marketing** finds people on Reddit, Hacker News and Stack Exchange who are asking for booking or scheduling help, and drafts helpful replies for you to review. It also writes SEO blog drafts based on those questions. **It never posts.** It only reads those sites through their official APIs, and you post every reply yourself under your own account. That keeps your accounts in line with each site's rules against automated self-promotion. It's **off until you switch it on** in Marketing → Settings, and **Run now** works while it's off.

- **Dashboard:** totals, a red alert when moderators remove one of your replies (the early warning before a ban), each job's last run and result, when it runs next, **Run now**, and recent activity.
- **Review queue:** each draft shows the thread, why it fits, any community-rule risk, and the reply (editable). Use **Copy & open thread**, post, then **I posted it**.
- **Posted log:** a direct link to your live comment (found through your usernames under Settings → Your accounts, or pasted by hand), live/removed status, score, and the approved text next to what's actually on the page. Rechecked every 6 hours for 30 days.
- **Activity:** every step and its reason: found, drafted, not a fit, skipped by a limit, posted, verified, removed, errors. Each entry links to its page.
- **Blog drafts:** Markdown articles to copy into your blog. Add the published URL to link it.
- **Limits** (Settings): at most 2 drafts per community per week. Once more than 30% of your last 20 posts mention Slotwise, new drafts are pure help. It ignores threads older than 3 days, needs a relevance of 7/10 or more, adds a disclosure line whenever it mentions Slotwise, and only claims the features listed under Product.
- **Keys** (Super admin → Settings → Marketing agent): it uses the AI assistant's Anthropic key unless you save its own. Reddit needs a free "script" app (reddit.com/prefs/apps) for its client ID and secret. Hacker News and Stack Exchange need no keys.
- **Cost:** one Claude request per new thread (capped by "Max new threads per scan") and two per blog draft.
- **How it's built:** everything lives in `server/src/marketing/` and its own `marketing_*` tables, and it runs in the same service and database. The scheduler checks every 5 minutes and runs one job at a time. Due times are stored in the database, so deploys don't cause repeat runs.
- API (super admin only): `GET /api/super/marketing/overview`, `POST …/run/:kind` (scan, verify, blog), `GET …/events`, `GET …/drafts`, `POST …/drafts/:id`, `GET …/posted`, `POST …/posted/:id/link`, `GET …/articles`, `PATCH …/articles/:id`, `GET/PUT …/settings`.

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
| Admin (per business) | `/api/admin/:bid` → settings, `/communications` (+ `/email`, `/sms`, `/email/test`, `/sms/check`), `/sms`, `/sms/test`, `/sms/simulate`, `/bookings/:id/sms-reminder`, `/services`, `/staff`, `/staff/:id/hours`, `/staff/:id/time-off`, `/bookings`, `/slots`, `/payments`, `/payments/:id/refund`, `/payment-provider`, `/billing/checkout`, `/billing/portal`, `/assistant`, `/stats`, `/audit` |
| Super admin | `/api/super/overview`, `/businesses`, `/businesses/:id/members`, `/users`, `/plans`, `/payments`, `/audit` |
| Payments | `/api/payments/:id/return`, `/api/payments/sync/:token`, `/api/webhooks/{stripe,square,paypal}` |
| SMS | `/api/webhooks/twilio/:bid/sms` (incoming texts to that business's number), `/api/webhooks/twilio/:bid/status` (delivery status), `POST /api/public/manage/:token/confirm` |

## Before launching for real

- [ ] Run on a host with HTTPS (Render, Fly.io, Railway, AWS). Set `NODE_ENV=production`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `PUBLIC_WEB_URL`, and `PUBLIC_API_URL`. Serve `web/dist` from a CDN or static host.
- [ ] **Database.** SQLite is fine for one server. To run several, move to Postgres; all SQL goes through `server/src/db.ts`.
- [ ] Tell businesses that texting needs their own Twilio number with **A2P 10DLC (or toll-free) registration**; texts sent before registration are blocked by US carriers.
- [ ] **Platform email provider** (Resend or Postmark) so password resets and owner alerts are delivered. (Customer emails go through each business's own account.)
- [ ] Switch your Stripe billing keys to live and register the webhook above.
- [ ] Fill in **Super admin → Settings → Legal pages** (company name, contact email, address, governing law). The Terms (`/terms`) and Privacy Policy (`/privacy`) pages are templates written around how Slotwise works: **have a lawyer review them.** They're linked from the home page footer, sign-up and every booking page. Use `https://<your domain>/privacy` as the privacy policy URL for Google's OAuth verification.
- [ ] Use a shared rate-limit store (Redis) if you run more than one API instance.
- [ ] Currencies are assumed to have 2 decimal places. Zero-decimal currencies such as JPY need adjusting in `payments/types.ts`.
