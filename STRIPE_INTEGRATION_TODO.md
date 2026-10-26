# Stripe Checkout integration: what's done and what's left

Slotwise already used **hosted Stripe Checkout** (customers are redirected to a Stripe-hosted payment page), so this was an update of the existing Checkout Session calls, not a new integration. No new files, routes or endpoints were added. Each of the three `checkout.sessions.create(...)` calls now carries the parameters configured in Checkout Studio.

| Where | What it's for | Stripe account | Mode |
|---|---|---|---|
| [server/src/lib/platformBilling.ts](server/src/lib/platformBilling.ts) | A business subscribing to a paid Slotwise plan | Yours (Super admin → Settings → Stripe) | `subscription` |
| [server/src/lib/usage.ts](server/src/lib/usage.ts) | A business buying extra booking / AI packs | Yours | `payment` |
| [server/src/payments/stripe.ts](server/src/payments/stripe.ts) | A customer paying a business for a booking | That business's own (its Payments tab) | `payment` |

## Values to Replace

**None.** Every `sample_only` parameter already has a real value in the code, so nothing uses a placeholder:

| Field | Current value | Notes |
|-------|--------------|-------|
| mode | `subscription` for plans; `payment` for packs and bookings | Already correct for each product. |
| success_url | Plans: `<site>/admin/<business>/billing?subscribed=1`. Packs: `<site>/admin/<business>/billing?pack=1`. Bookings: `<site>/manage/<token>?paid=1&session_id={CHECKOUT_SESSION_ID}` | Built from the **Website address** setting (Super admin → Settings → Website address, e.g. `https://bookwithslotwise.com`). |
| cancel_url | The same pages without the success flag | Same as above. |
| line_items | Built on the fly with `price_data` from the plan, pack or booking price | Slotwise's prices are edited in **Super admin → Plans & fees** and each business's **Services**, so no Stripe Price IDs (`price_...`) are needed. |

## Configured Parameters

These parameters were configured in Checkout Studio and are now set in all three calls.

**Files containing these parameters:**
- [server/src/lib/platformBilling.ts](server/src/lib/platformBilling.ts)
- [server/src/lib/usage.ts](server/src/lib/usage.ts)
- [server/src/payments/stripe.ts](server/src/payments/stripe.ts)

| Parameter | Value | Notes |
|-----------|-------|-------|
| ui_mode | `hosted_page` | The installed Stripe Node SDK is **23.0.0** (`server/package.json`: `^23.0.0`). SDKs from 21.0.0 use `hosted_page`; older ones call it `hosted`. Revisit this if the SDK is ever downgraded below 21. |
| billing_address_collection | `auto` | Replaces the earlier `required` (which was used when tax was on). With `automatic_tax` on, Checkout still asks for whatever address Stripe Tax needs. |
| phone_number_collection | `{ enabled: false }` | |
| automatic_tax | `{ enabled: false }` **unless tax is switched on** | See "Decisions" below. |
| allow_promotion_codes | `false` | |
| payment_method_collection | `always` | **Plans only**, because Stripe only accepts it in `subscription` mode. |
| submit_type | `auto` | |
| integration_identifier | `hosted_web_0001` | |
| origin_context | `web` | |

### Decisions you made (where Studio and Slotwise disagreed)

1. **Tax: Slotwise's "Charge tax" switch wins.**
   - **Your own Checkouts (plans and packs):** they use `automatic_tax: { enabled: false }` (Studio's value) while **Super admin → Settings → Stripe → Charge tax** is *off*, and `{ enabled: true }` when it's *on*. When it's on, they also send `tax_id_collection` and, for returning customers, `customer_update` (Stripe requires that to save the address used for tax).
   - **Customer payments to a business:** they follow that business's own **Add sales tax at checkout** box on its Payments tab.
2. **Kept the parameters Slotwise depends on.** Studio's instructions said to remove anything not in its list. These were kept because payments would otherwise never activate anything:
   - `metadata` and `subscription_data.metadata`: which business and plan or pack was paid for (read by the webhooks).
   - `customer` / `customer_email`: reuses the business's existing Stripe customer, so the "Manage billing" portal and invoices stay in one place.
   - `payment_intent_data.metadata`: links a customer's payment back to the booking (used for confirmations and refunds).
   - `tax_id_collection` / `customer_update`: only sent when tax is on (see 1).

## Setup and next steps

### Environment variables and keys

No `.env` changes are needed. Slotwise reads Stripe keys from **Super admin → Settings → Stripe**, stored encrypted in the database, and falls back to Render's environment variables of the same names:

| Name | Where it's used | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Server only | `sk_test_…` in a sandbox, `sk_live_…` for real money. Never exposed to the browser. |
| `STRIPE_WEBHOOK_SECRET` | Server only | The `whsec_…` signing secret of your webhook endpoint. |

No publishable key (`pk_…`) is needed: hosted Checkout runs on Stripe's page, so the browser never loads Stripe.js. That also means no `VITE_`-prefixed Stripe variable exists or is needed. Each business enters its own keys on its **Payments** tab for customer payments. The SDK is already installed (`stripe` in `server/package.json`). The Stripe client is created without an `apiVersion`, so it uses the SDK's default.

### Project structure

No new source files were created. Only the three files listed above were changed, plus this file and one test expectation ([server/test/stripeLive.test.ts](server/test/stripeLive.test.ts)).

### How it works

1. **Plans.** A business clicks a plan in **Plan & billing**. The server creates a `subscription` Checkout Session and redirects to Stripe. After payment, Stripe sends `checkout.session.completed` to `/api/webhooks/stripe`, and Slotwise switches the plan on (`customer.subscription.updated` / `deleted` keep it in sync later).
2. **Booking packs.** Same flow in `payment` mode. The webhook adds the extra bookings or AI messages.
3. **Customer payments.** A customer books a paid service. The server creates a `payment` Checkout Session on the business's own Stripe account and redirects. On return (and via `/api/webhooks/stripe/<business id>`), the booking is confirmed.

### Testing (in a Stripe sandbox, with `sk_test_…` keys)

1. **Check Stripe accepts the new parameters.** This is the one thing the automated tests can't check, because they don't call Stripe. Start one plan checkout and one booking checkout in a sandbox and confirm Stripe's page opens. If Stripe answers `Received unknown parameter` for `integration_identifier` or `origin_context`, your account doesn't have them yet: ask Stripe support, or remove those two lines from the three calls.
2. Use any future expiry date, any CVC and any ZIP with these test cards:

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0025 0000 3155` | Asks for 3-D Secure (the bank's extra check) |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Declined: insufficient funds |
| `4000 0000 0000 0341` | Card saves, later renewals fail |

3. Check the results:
   - the plan changes in **Plan & billing**;
   - the payment and subscription appear in the Stripe Dashboard;
   - **Developers → Webhooks → Event deliveries** shows `200` responses.

   Then switch **Charge tax** on and check that a tax line appears on Stripe's page.

### Next steps

- **Going live:** follow the "Going live" steps you already have:
  - put the `sk_live_…` key and a live `whsec_…` in Super admin → Settings → Stripe;
  - set up the live webhook with `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`;
  - save the customer portal once in live mode;
  - set up Stripe Tax in live mode if you charge tax.
- **Promotion codes:** Studio turned them off (`allow_promotion_codes: false`). If you later want launch discounts, change it to `true` in the three calls and create codes in the Stripe Dashboard.
- **Products and prices** are managed in Slotwise (**Plans & fees**, each business's **Services**), not as Stripe Prices, so there's nothing to set up in Stripe's product catalogue.
- **Fulfilment and order tracking** are already handled by the webhooks above. Payments are listed under **Super admin → Payments** and each business's **Payments** tab.

### Resources

- Stripe support: https://support.stripe.com
- Stripe's MCP server (for AI tools): https://docs.stripe.com/mcp
