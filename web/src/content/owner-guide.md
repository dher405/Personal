# Slotwise Business Owner Guide

*Last updated October 20, 2026.*

## Welcome and 15-minute quick start

Slotwise gives your business an online booking calendar. Customers pick a service, see only the times you are actually free, book, and pay. They can then confirm, reschedule or cancel on their own by web or text message. You manage everything from one admin screen on any computer or phone.

Everything below is done from your admin screen. Sign in, then click **Admin** at the top of the page. The tabs across the top (Dashboard, Bookings, Services & prices, Staff & hours, Payments, Email, Text messages, Calendar sync, AI assistant, Plan & billing, Settings, Add to website) match the sections of this guide.

To be ready for your first booking, work through this list in order. Your **Dashboard** shows the same checklist and ticks items off as you finish them.

- [ ] **Check your business details** (Settings): name, address, phone, time zone and currency. The time zone matters most: every time shown to customers uses it.
- [ ] **Add yourself and any staff** (Staff & hours), and set each person's weekly working hours.
- [ ] **Add your services or lessons** (Services & prices): name, length, price, and who provides each one.
- [ ] **Set your booking rules** (Settings): minimum notice, how far ahead people can book, and your cancellation cutoff.
- [ ] **Book a test appointment yourself** from your booking page to see what customers see.
- [ ] **Optional: connect payments** (Payments) if you want customers to pay or leave a deposit when they book.
- [ ] **Connect your email** (Email) so customers get booking confirmations from your own address. Until you do, customers get no emails. **Optional:** connect your Twilio account for text reminders (Text messages), and turn on the **AI booking assistant** (AI assistant).
- [ ] **Optional: connect your Google Calendar or Outlook** (Calendar sync) so bookings appear there with phone reminders, and your own events block those times.
- [ ] **Put booking on your website** (Add to website), and share your booking link on social media and Google.

## Signing in and your account

You can sign in with an email and password, or with your Google or Apple account if those buttons appear on the sign-in page.

**Creating your business account**

1. On the Slotwise home page, click **List your business**.
2. Either click **Continue with Google / Apple**, or fill in your name, email, a password (8+ characters), your business name and time zone.
3. If you used Google or Apple, you'll be asked for your business name next.
4. You land on your Dashboard with the setup checklist.

**Using Google or Apple with an existing account.** If your Google or Apple account uses the same email as your Slotwise account, signing in with it opens your existing account and businesses. Nothing needs linking by hand.

**Forgot your password?** On the sign-in page, click **Forgot password?**, enter your email, and open the link we send you. The link works once and expires after 1 hour. Setting a new password signs you out on all other devices. If the email doesn't arrive, check your spam folder or ask Slotwise support, who can send you a reset link.

**Changing your password.** Click **Account** at the top of any page. If you joined with Google or Apple, you can add a password there too, so you can also sign in with your email.

**Several businesses or locations.** One account can manage several businesses. Click **Admin** to choose between them. Ask Slotwise support to give another person (a manager or co-owner) admin access to your business.

## Services, lessons and prices

A service is anything customers can book: a haircut, a 30-minute piano lesson, a consultation. Each one has its own length, price and list of staff who provide it.

To add one, open **Services & prices** and click **+ Add service**. To change one, click **Edit** on its row. A price change applies to new bookings only; existing bookings keep the price they were booked at, unless you change a booking's price yourself (see Managing bookings).

| Field | What it does | Example |
| --- | --- | --- |
| Name | What customers see and pick | Piano lesson (60 min) |
| Description | A short line under the name | Beginners welcome |
| Category | Groups related services | Piano |
| Duration (min) | How long the appointment lasts | 60 |
| Buffer after (min) | Time blocked after it for cleanup or travel; customers don't see it | 10 |
| Price | The full price | 75.00 |
| Deposit (optional) | Charge only this much online when payment is required; the rest is collected in person | 20.00 |
| Who provides it | Staff customers can book for this service | Alex Kim |
| Bookable | Untick to hide the service without deleting it | On |

Tips:

- **Offer a free intro.** A free trial lesson or consultation is a good way to turn first-time visitors into customers. Free services never ask for payment.
- **Several lengths or levels:** add each as its own service (30, 45 and 60 minutes) so each gets the right price and length.
- **A service with nobody assigned can't be booked.** It shows a "none" warning in the Staff column.

## Staff, working hours and time off

Customers can only book times when someone who provides that service is working and free. So each person's weekly hours and time off are what make your calendar.

**Add staff.** In **Staff & hours**, type a name and click **Add**. If you work alone, add yourself. How many staff you can add depends on your plan (see Plans and billing).

**Set weekly hours.** On each person's card:

1. Click **+ Add block**, pick a day, and set the start and end time.
2. Add as many blocks as needed. For a lunch break, add two blocks on the same day: 9:00–12:00 and 13:00–17:00.
3. Click **Save hours**.

Times are in your business's time zone, which is shown on the card.

**Block time off** for a holiday, appointment or a day you're closed. Under **Time off**, pick a start and end, add a reason if you like, and click **Block time**. Customers won't be offered those times. Existing bookings in that window are not moved automatically, so check the Bookings screen and move them if needed. Click **remove** to reopen the time.

**Mobile number for "up next" texts.** Enter a staff member's mobile and click **Save phone**. If staff texts are turned on (Text messages), they get a text before each appointment.

**Someone leaves or is off for a while?** Click **Deactivate**. Their past bookings stay on record, but customers can no longer book them. Remember to move any future bookings they had.

## Booking rules

Four settings control when customers can book and change appointments. Change them in **Settings**, then click **Save settings**.

| Setting | What it controls | Default | Example |
| --- | --- | --- | --- |
| Start times every (min) | How often a start time is offered | 15 | 30 offers 9:00, 9:30, 10:00 |
| Minimum notice (min) | The latest someone can book before a time | 60 | 1440 means no same-day bookings |
| Book up to (days ahead) | How far ahead the calendar opens | 60 | 14 for a two-week rolling diary |
| Online cancel/reschedule cutoff (hours) | Customers can change or cancel themselves until this many hours before; after that they must contact you | 24 | 48 for a stricter policy |

The cutoff is also your cancellation policy for payments. A customer who cancels themselves before the cutoff is refunded automatically if they paid online. After the cutoff they can't cancel online, and it's up to you whether to refund.

The Settings tab also holds your business name, description, address, phone, time zone and currency, all shown on your booking page. Your **booking link** is shown at the bottom of Settings.

## Adding booking to your website

You can put your live calendar on your own website so customers book without leaving it. Open **Add to website**, choose a style, copy the code, and paste it into your site. You don't need to change any code; the tab writes it for you.

| Style | What visitors see | Best for |
| --- | --- | --- |
| Calendar on the page | The full booking calendar inside your page, growing to fit | A "Book" or "Lessons" page |
| Button that opens a pop-up | A button; clicking it opens the calendar over your page | Home page, service pages |
| Floating button on every page | A round "Book now" button fixed in the bottom-right corner | Booking from anywhere on the site |
| Plain link | An ordinary text link to your booking page | Menus, emails, places that don't accept code |

Options on the same tab:

- **Start on one service:** opens straight on, say, the free trial lesson. Useful on a page about one service.
- **Button text** and **Colour:** match your website's brand colour.
- **Show business name and address:** untick it when your page already shows them.
- **Your own button:** if your site already has a "Book" button or menu link, paste the code once anywhere on the page, then add `data-slotwise-open` to that button or link. It will open the pop-up.

The **Preview** at the bottom is live: bookings made there are real.

**Where to paste the code in common website builders.** Menu names change from time to time; look for a block called Embed, HTML or Custom code.

| Website builder | Where to paste |
| --- | --- |
| WordPress | Edit the page, add a **Custom HTML** block, paste, then Update |
| Wix | **Add Elements → Embed Code → Embed HTML**, paste, then drag the box taller (about 1,000 px) for the calendar style, or use a button style |
| Squarespace | Edit the page, add a **Code** block, paste. Running code needs a plan that allows custom code |
| Shopify | **Online Store → Pages**, edit a page and switch the editor to HTML (the `<>` button), or add a **Custom Liquid** section in the theme editor |
| GoDaddy Website Builder | **Add Section → HTML**, paste |
| Hand-built site | Paste the line where it should appear in the page's HTML |

**Places that only take a link** (no code): use your booking link from the top of the tab.

- **Google Business Profile:** add it as your booking or appointment link, so a "Book" button appears on Google Search and Maps.
- **Instagram, TikTok, Facebook:** put it in your bio, or as the Facebook Page's "Book now" button.
- **Email signature, texts, flyers:** paste the link, or turn it into a QR code with any free QR generator.

Payment pages open in a new browser tab, because payment providers don't allow checkout inside another website. After paying, the customer sees their confirmed booking in that tab.

For your web designer: each completed booking fires a `slotwise:booked` event on your page (with the booking code), which they can connect to analytics or an ad conversion.

## What your customers see and do

Customers book in about a minute without creating an account. They can then confirm, reschedule or cancel themselves by web or text, within your cancellation cutoff.

&#91;embedded content: customer journey · 4 booking steps, 3 ways to change\]

**Booking.** On your website (or your booking link) customers:

1. **Choose a service.** They see each service's name, length and price, with "Free" shown for free ones.
2. **Choose who, if you have several staff.** They can pick a person or leave it on "Anyone available".
3. **Pick a day and time.** A week of days is shown with the open start times underneath. Only times when someone is free for the whole appointment appear, in your time zone, and the arrows move between weeks.
4. **Enter their details:** name, email, optional phone and notes. If you've connected texting, they can tick **Text me my confirmation and reminders**.
5. **Confirm,** or **Continue to payment** if you require payment. The time is held for 30 minutes while they pay. If they don't finish, it's released. If you allow it, they can choose \*\*Pay in person\*\* instead, which sends you a request to accept or decline (see Getting paid).

They then see **"You're booked!"** with their booking code and a **Manage or reschedule** button. A confirmation goes to their email (once you've connected your email account; see Emails to your customers) and, if they opted in, by text.

**Adding it to their own calendar.** The "You're booked!" screen and the booking's manage page both have **Add to your calendar** buttons:

| Button | Opens |
| --- | --- |
| Google Calendar | Google Calendar with the appointment filled in; they click Save |
| Outlook.com | Outlook on the web for personal accounts (Hotmail, Outlook.com) |
| Outlook (work/school) | Outlook on the web for work or school Microsoft 365 accounts |
| Apple / other (.ics) | A calendar file that opens in Apple Calendar on iPhone and Mac, desktop Outlook and most other apps |

The confirmation email also carries a calendar invitation. In Gmail, Outlook and Apple Mail it shows as an event they can add in one click. When the booking is later rescheduled, the update email moves that same calendar entry to the new time; when it's cancelled, the entry is removed. Customers don't need to delete or re-add anything.

**Changing or cancelling on the web.** Every booking has a private manage page. Customers reach it from the button after booking, the link in their confirmation text, or **My bookings** if they have an account. On it they can:

- **✓ I'll be there:** confirm they're coming. You'll see "✓ customer confirmed" on the booking.
- **Reschedule:** pick a new time from the same calendar.
- **Cancel booking:** cancel and get an automatic refund if they paid online.
- **Complete payment,** if they left before paying.

Rescheduling and cancelling online close at your cutoff (24 hours before by default). After that the page asks them to call you, using the phone number in your Settings.

**Changing by text message,** if they opted in to texts. Every reminder tells them what to reply:

| They reply | What happens |
| --- | --- |
| C | Confirms they're coming |
| R | They get three new times; replying 1, 2 or 3 moves the booking |
| X | Cancels (within your cutoff), with an automatic refund if they paid |
| Anything else | The AI assistant answers, if you've turned it on; otherwise they get the C/R/X options again |
| STOP | Stops all texts to them (START turns them back on) |

**Booking by chat.** If the AI assistant is on, your booking page shows a **Book by chat** button. Customers can type something like "Do you have anything Thursday after school for a beginner guitar lesson?" The assistant offers real open times, takes their details, confirms everything back to them, and books. It can also move or cancel a booking if they give their booking code and email.

**On phones.** Your booking page and website calendar fit phone screens, and customers can also use the Slotwise app. The steps are the same everywhere.

## Managing bookings day to day

The **Dashboard** shows today's appointments and this month's numbers. The **Bookings** tab is where you see and change everything.

**Finding bookings.** Bookings lists the next two weeks by default. Change the **From** and **To** dates, filter by **Status**, or search by name, email or booking code. Each row shows:

- the time and booking code, and where it came from (web, mobile, AI or admin)
- the customer's contact details, the service and the staff member
- the price and what's been paid or refunded
- the status, "✓ customer confirmed" if they confirmed, and "texts on" if they agreed to texts

| To do this | Do this |
| --- | --- |
| Book someone in yourself (phone or walk-in) | **+ New booking**: pick the service and a time, enter their details. You can set a custom price, and tick that they agreed to texts |
| Move a booking | **Edit / move**: pick a new time or staff member, then **Save changes**. The customer is texted the new time if they opted in |
| Book outside your normal hours | In Edit / move, tick **Override availability** and type any date and time |
| Change the price of one booking | **Edit / move**: change **Price**, then **Save changes** |
| Add a private note | **Edit / move**: **Notes** (customers don't see these) |
| Send a reminder now | **Text reminder** (customers who agreed to texts only) |
| Record how it went | **Done** (completed) or **No-show** |
| Cancel | **Cancel**. This does not refund automatically; see below |
| Answer a pay-in-person request | Click Accept or decline in the banner (or filter Status to "requested"), then Accept or Decline on the booking |

**Refunds.** Open **Edit / move** on the booking. Under **Refunds**, leave the amount blank for a full refund or type an amount for a partial one, then click **Refund** and confirm. The money goes back through the same payment provider, usually in 5–10 business days. You can also refund from the **Payments** tab. A refund can't be undone.

**When customers act themselves,** you don't need to do anything. Their changes appear here straight away, and you can get a text for each one (see Text messages).

## Getting paid

Customer payments go straight into your own Stripe, Square or PayPal account. Slotwise never sees card numbers: customers pay on the provider's own secure checkout page.

In **Payments**, choose a provider, follow the numbered steps shown under it, and click **Save payment settings**. Then click **Test connection** to check that everything works. Secret keys are stored encrypted and only their last 4 characters are ever shown; leave a key box blank to keep the one already saved.

| Provider | What you enter | Where to find it |
| --- | --- | --- |
| Stripe | Secret key, and webhook signing secret | Stripe → Developers → API keys; Developers → Webhooks (add your webhook URL with the event `checkout.session.completed`) |
| Square | Access token, location ID, environment, and optional webhook signature key | Square Developer dashboard → your app → Credentials, Locations, and Webhooks (event `payment.updated`) |
| PayPal | Client ID, secret, environment, and optional webhook ID | developer.paypal.com → Apps & Credentials (webhook events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`) |
| Test mode | Nothing | Bookings "pay" instantly with no real money; for trying things out only |
| No online payments | Nothing | Customers book without paying; you take payment in person |

No account yet? Create one with the provider first and add your bank details there; the Payments tab links to each one. Where a webhook is involved, the Payments tab shows **your own webhook URL** with a **Copy** button; paste it into the provider exactly as shown. Webhooks are a backup: a payment is also confirmed when the customer comes back from the payment page.

**Require payment to confirm online bookings.** Tick this to make customers pay (or pay the deposit, if a service has one) before their booking is confirmed. Free services and bookings you add yourself never ask for payment.

**Letting customers pay in person (cash) instead.** If you require payment but some customers would rather pay cash, tick **Let customers ask to pay in person (cash) instead** in **Payments**. Customers then see two choices when they book: *Pay online now* (confirmed straight away) or *Pay in person*. Choosing pay in person sends you a **request**:

- The time is **held** for them, so nobody else can book it, and no card payment is taken.
- They get a "we've received your request" email. It says you'll confirm, and doesn't add anything to their calendar yet.
- You get an email, a text if you've connected texting, and a banner at the top of every admin page: "1 customer is asking to pay in person. **Accept or decline**".
- **Accept** (in **Bookings**) turns it into a normal confirmed booking marked 💵 *pays in person*. The customer gets the usual confirmation with the calendar invite and the amount to bring. It counts toward your plan's bookings only once you accept it.
- **Decline** releases the time and emails the customer, with an optional note from you (for example "We need card payment for first lessons"). Nothing is charged.
- Customers can cancel their own request at any time from the link in their email. A request you don't answer is released automatically when its appointment time arrives, and the customer is told.

If you never want card payments at all, choose **No online payments** instead: every booking is then confirmed straight away and paid in person.

**No fees from Slotwise on your payments.** Every payment goes straight into your own account, and Slotwise takes nothing from it; only your provider's own card fees apply. You pay Slotwise for your plan, which is based on the number of bookings you take (see Plans, usage and billing).

**The Payments list** shows every payment with its booking, amount, provider and status (paid, partially refunded, refunded). You can refund from there too.

## Emails to your customers

Booking confirmations (with a calendar invite), changes and cancellations are emailed to customers **from your own email address**, through your own email account, so replies come straight to you. **Until you connect your email, customers don't get any emails.** Set it up in **Email**.

**Using your Gmail, Microsoft 365, Outlook or web-host email (most businesses)**

1. In **Email**, leave **Send with** on *My email account*.
2. Enter the **From name** customers see (usually your business name) and the **From address**. Optionally add a different **Replies go to** address.
3. Pick your **Email service**. The server, port and security fill in for you.
4. Enter your **user name** (usually your full email address) and **password or app password**, then click **Save email settings**.
5. Click **Send me a test email** and check that it arrives (look in spam too).

| Email service | What you need |
| --- | --- |
| Gmail or Google Workspace | Turn on 2-Step Verification for the Google account, then create an **app password** at myaccount.google.com/apppasswords and use it instead of your normal password. The From address must be that Gmail address, or one added under Gmail Settings → Accounts → "Send mail as" |
| Microsoft 365 or Outlook | Your mailbox address and password (or an app password if it has two-step verification). On Microsoft 365, your administrator may need to turn on **Authenticated SMTP** for the mailbox. If Microsoft won't allow it, use your web host's email or Resend instead |
| Zoho, iCloud, Yahoo | Your address and an app password from that provider's security settings |
| Your web host (GoDaddy, Bluehost, Squarespace Email and others) | The "outgoing mail (SMTP)" server, port and security from your host's help pages |

**Using your own domain with Resend.** If you'd rather not use a mailbox password, choose **Resend** under Send with. Create a free account at resend.com, add your domain under Domains and add the DNS records it shows at your domain host, then create an API key with sending access and paste it in. Use a From address at that domain.

**The Email log** lists every email sent to a customer, with its status: **sent**; **failed**, with the reason your email provider gave (for example a wrong password); or **not sent**, meaning email wasn't set up yet. Click a subject to see exactly what was sent.

Passwords and keys are stored encrypted and never shown again; leave a box blank to keep the saved one. **Turn off customer emails** stops them completely. Emails to you, such as new-booking alerts and usage warnings, come from Slotwise and don't need any setup.

## Text messages

Text reminders cut no-shows and let customers confirm or change their booking by replying. You can get texts too. Texts are sent from **your own Twilio phone number**, and Twilio bills you for them directly; they aren't part of your Slotwise plan. **Until you connect Twilio, texting is hidden everywhere**: customers aren't offered texts on your booking page, website calendar, the app or the AI chat.

**Connecting your Twilio account** (top of **Text messages**)

1. Sign up at twilio.com and buy a phone number that can send SMS.
2. In the US, register the number before carriers will deliver your texts: **A2P 10DLC** registration for a local number, or **toll-free verification** for a toll-free number, both in the Twilio Console. This can take a few days, so start early.
3. From the Twilio Console home page, copy your **Account SID** and **Auth token** into Slotwise, add your Twilio phone number (or a Messaging Service SID), and click **Save Twilio settings**.
4. Copy your **Incoming messages webhook** from the same box. In Twilio, open your number under Phone Numbers → Manage → Active numbers, and under **Messaging → A message comes in** choose Webhook, paste the address, set HTTP POST and save. This is what lets customers reply C, R or X.
5. Click **Check connection**. It confirms Twilio accepts your details and that the number belongs to your account.

Then set up your reminders below it and click **Save**.

**For your customers**

- Tick **Send text messages**.
- Set **Remind customers this many hours before**: for example `24,2` sends one reminder the day before and one 2 hours before. Someone who books after a reminder's time only gets the later ones.
- Customers are only ever texted if they ticked "Text me" when booking (or told you they agreed, when you book them in). This consent is required by law in many places, including the US.

**For you and your staff**

| Setting | What you get |
| --- | --- |
| Your mobile number | Where your alerts and agenda go |
| Text me when customers book, confirm, reschedule or cancel | A short text for each change customers make (not for changes you make) |
| Morning agenda text at | Today's appointments in one text at the hour you pick |
| Text staff before each appointment | An "up next" text to the staff member's mobile, 15 minutes to 2 hours before |

**Texting in.** From your own mobile, text **TODAY** or **TOMORROW** to your Twilio number to get your schedule. On plans with the AI assistant you can also text plain requests, such as "move Pat to Friday at 3" or "cancel the 4pm".

**Testing.** **Send me a test text** sends a real text from your Twilio number to your mobile. On the demo or test system there's also a **Test mode** under Texting: texts are shown in the **Message log** instead of being sent, and the **Try a reply** box lets you pretend to be a customer replying C, R or X.

**Message log.** Every text in and out, with its delivery status. "Skipped" means it wasn't sent, and the reason is shown, such as the person replied STOP to your number.

**What texts cost.** Twilio charges your Twilio account for each text at its own rates; Slotwise doesn't count or charge for texts. **Disconnect** (in the Twilio box) switches texting off and hides it from customers again.

## Calendar sync: Google Calendar and Outlook

Connect your Google Calendar or Outlook, and every booking appears there within seconds, with a reminder on your phone. Your existing events in that calendar also block those times on your booking page, so customers can't book over your dentist appointment or day off. Set it up in **Calendar sync**.

**Connecting a calendar.** Each staff member is connected separately, so each person's bookings land in their own calendar.

1. Find the person and click **Connect Google Calendar** or **Connect Outlook**.
2. Sign in to the Google or Microsoft account whose calendar you want to use, and click **Allow**. A staff member can sign in to their own account on your screen.
3. You come back to Slotwise with "connected" at the top. Upcoming bookings are copied in straight away.

**What happens next**

| When | In the connected calendar |
| --- | --- |
| A booking is made (by anyone) | An event appears: service and customer name, their phone, email and notes |
| A booking is moved | The event moves to the new time |
| A booking is cancelled | The event is removed |
| Before each appointment | A reminder pops up on your phone and computer (30 minutes by default) |
| You add a personal event | Those times disappear from your booking page within about a minute |

On each connection you can:

- **Block times that are busy in this calendar.** Untick it if the calendar holds things that shouldn't stop bookings. Events marked "Free" or "Available" never block.
- **Reminder:** choose when your phone reminder goes off, from "at start time" to "1 day before".
- **Sync now:** copy all upcoming bookings again, for example after deleting events by mistake.
- **Disconnect:** remove upcoming bookings from that calendar and stop syncing.

**Make changes in Slotwise, not in Google or Outlook.** Dragging or deleting an event in your calendar doesn't change the booking, and the customer isn't told. Move or cancel it in Bookings and the calendar follows. A problem with a connection (for example, if you change your Google password) shows in red on the connection; reconnect to fix it.

**Subscribe link (any calendar app, no sign-in).** The same tab gives a private web address for all bookings, and one per staff member. Paste it into your calendar app:

| App | Where |
| --- | --- |
| Google Calendar (web) | Other calendars **+** → **From URL** |
| Outlook (web) | **Add calendar** → **Subscribe from web** |
| Apple Calendar | **File** → **New Calendar Subscription** (Mac); Settings → Calendar → Accounts → Add Subscribed Calendar (iPhone) |

A subscription is read-only, and calendar apps check it only every few hours (Google can take up to a day). Use **Connect** above for real-time updates. Anyone with the address can see the bookings, so keep it private; **Make new addresses** stops old ones working.

**Email alerts.** Tick **Email me when customers book, confirm, reschedule or cancel** to get an email at your Gmail, Outlook or any other address for each change customers make. Every admin of the business gets them.

## The AI assistant

The AI assistant books, moves and cancels appointments by chat, using only the times your calendar actually has open. It comes in two parts, both on paid plans, and each reply it gives counts toward your monthly AI assistant messages.

**Customer chat (on your booking page, website calendar and texts).** In **AI assistant**, tick **Enable AI booking chat** and click **Save**. Use **Instructions for the assistant** to tell it what a good receptionist would know, for example:

- New students should start with the free trial lesson.
- We don't teach drums; suggest Hudson Drum School.
- Parking is behind the building; use the side door.
- For groups of more than 3, ask them to call us.

It always gathers the customer's name and email, repeats the service, time, staff and price back to them, and only books once they say yes. It can't give discounts or change prices for customers. It stays on the topic of your appointments.

**Your admin assistant** is on the right of the same tab, and it also answers when you text in. Ask in plain words:

| Ask | It will |
| --- | --- |
| What's on tomorrow? | List tomorrow's bookings |
| Move Jo's lesson to Friday at 3 | Check Friday at 3 is free, then move it |
| Book Pat Lee for a 60-minute piano lesson next Tuesday at 10 | Create the booking |
| Block Alex off next Monday | Add time off to Alex's calendar |
| Raise the 60-minute lesson to $80 | Ask you to confirm, then change the price |

It asks before cancelling, changing a price, or booking outside your hours. **It cannot issue refunds**; those are always done by a person in Bookings or Payments. Check the Bookings tab after big changes.

## Plans, usage and billing

Slotwise is priced by the number of bookings you take. There is no fee on your customers' payments: they go straight to your own Stripe, Square or PayPal account. Each plan includes a monthly allowance of bookings and AI assistant messages, plus a staff limit. Texts aren't part of your plan: Twilio bills you for them directly. Your plan's allowances are shown in **Plan & billing**; these were the defaults when this guide was written:

| Plan | Monthly | Bookings | AI assistant messages | Staff |
| --- | --- | --- | --- | --- |
| Starter | Free | 25 | Not included | 1 |
| Pro | $29 | 300 | 1,000 | 5 |
| Business | $79 | 2,000 | 5,000 | 50 |

**What counts as a use**

| Allowance | Counts | Never counts |
| --- | --- | --- |
| Bookings | Every booking, whether customers make it online (website, booking page, app or AI chat) or you add it yourself, once it's confirmed. A pay-in-person request counts once you accept it. A booking that's later cancelled still counts | An online booking whose payment was never completed |
| AI assistant messages | Each reply the assistant gives, to customers (web, app or text) or to you | Anything else |

Allowances reset on the 1st of each month.

**Tracking your usage.** The **Dashboard** shows a bar for each allowance: green, amber from 80%, red when used up. **Plan & billing** shows the exact numbers, how many are left, and the reset date. From 80%, a warning banner appears at the top of every admin page (for example "You've used 270 of 300 bookings this month (90%); 30 left") with a link straight to adding more or upgrading.

**Email alerts.** Every admin of your business gets an email when an allowance reaches 80%, again at 90%, and when it's used up at 100%, once each per month. The email says how much is left and your options: buy a pack, upgrade to the plan that includes more, or turn on auto top-up.

**When an allowance runs out**

| Allowance | What happens until you add more |
| --- | --- |
| Bookings | New bookings pause. Your booking page and website calendar show "Online booking is unavailable right now" with your phone number, and bookings you add yourself are blocked too. Existing bookings, reschedules and cancellations still work |
| AI assistant messages | The chat button disappears (customers can still book with the calendar) and your admin assistant stops |

**Adding more right away.** In **Plan & billing → Need more?**, pick a pack and how many, then click **Buy** and pay by card. The extra uses are added immediately and last until the end of the month; unused ones don't carry over. Default packs: 50 bookings for $10, 250 AI assistant messages for $10.

**Auto top-up.** Tick **Auto top-up** and, whenever something runs out, the smallest pack is added automatically. It goes on your next monthly invoice and you get an email each time. It's available on paid plans only, because top-ups are added to your monthly plan invoice. On Starter, buy packs as you need them.

**Pack or upgrade?** If you buy packs most months, compare their cost with the next plan up; the alert email names the plan that would cover you.

**Changing plan.** Click **Switch to …** on a plan. Upgrades open a secure card payment page and take effect as soon as payment goes through, including the bigger allowances. Switching between paid plans is prorated. **Manage billing & invoices** lets you update your card, download invoices or cancel. If you cancel a paid plan, it runs until the end of the month you've paid for, then you move to Starter and keep all your bookings. The last section of this guide explains every charge and option in detail.

## The mobile app

**For iPhone and Android.** Sign in with the same account and tap your business under **Account** to see the next 14 days of bookings. Tap a booking to:

- call or email the customer
- move it (type the new date and time)
- change its price
- mark it completed or a no-show
- cancel it, or refund a payment

Pull down to refresh. Setting up services, hours, payments and texts is done on the website.

## Troubleshooting and FAQ

| Problem | Check |
| --- | --- |
| Customers see "No open times" | The staff member has weekly hours on that day (Staff & hours), the service has someone assigned (Services & prices), and the day is inside your "Book up to" window and past your minimum notice |
| A time shows that shouldn't | Block it as time off. Remember each service's buffer is added after the appointment, not before |
| Times are an hour or more off | Your time zone in Settings. Customers always see your business's time zone, which is labelled on the calendar |
| The calendar doesn't appear on my website | The code was pasted into an HTML/Embed/Code block, not a normal text block. Some builders only run code on the published page, not in the editor preview |
| The calendar on Wix is cut off | Make the Embed HTML box taller, or use the pop-up button style instead |
| A customer didn't get their text | They ticked "Text me" when booking; the Message log shows the reason if it was skipped (STOP, invalid number, texting not connected). Check connection in the Twilio box confirms your account works, and US numbers must be registered (A2P 10DLC or toll-free) before carriers deliver |
| A customer can't cancel online | They're past your cutoff. You can cancel for them in Bookings, and decide on a refund |
| A payment shows pending | They didn't finish checkout. The time is released after 30 minutes, or they can use **Complete payment** on their manage page |

| Calendar problem | Check |
| --- | --- |
| Bookings aren't appearing in my Google/Outlook calendar | Calendar sync shows the connection without a red problem message. Click **Sync now**. If there's a problem, Disconnect and Connect again |
| A time I'm busy in Google/Outlook is still offered | "Block times that are busy" is ticked on that person's connection, and the event isn't marked Free/Available. Changes take up to a minute to show |
| My subscribed calendar is out of date | Subscriptions refresh every few hours. Use Connect for real-time sync |

**Customers see "Online booking is unavailable right now".** This month's bookings are used up. Buy a pack or upgrade in Plan & billing and booking reopens immediately. Turn on auto top-up so it can't happen again.

**The chat button has disappeared.** Your AI assistant messages are used up for the month; the Plan & billing page shows the numbers.

**Customers aren't getting emails.** Open **Email**. If the badge says "Not set up", connect your email account; until then no customer emails are sent. If it's set up, check the **Email log**: a *failed* email shows your provider's reason (a wrong or expired app password is the most common; "Couldn't connect" means your email server couldn't be reached from Slotwise, so switch to Resend or contact Slotwise support), and **Send me a test email** shows the error straight away. If emails show *sent* but don't arrive, ask the customer to check spam, and use a From address your account is allowed to send from.

**There's no "Text me" box on my booking page.** Texting only appears once your Twilio account is connected and **Send text messages** is ticked in **Text messages**.

**Can customers book without an account?** Yes. They only need a name and email. Creating an account lets them see all their bookings under My bookings.

**Can I take a booking over the phone?** Yes: **Bookings → + New booking**. You can book outside your normal hours with Override availability. Phone bookings count toward your plan's monthly bookings like any other.

**Do I have to take payment online?** No. Choose "No online payments" and take payment in person, or require only a deposit.

**What if someone books by mistake twice?** Cancel one in Bookings. Two people can never book the same staff member at the same time.

**Who do I contact for help?** Slotwise support, from your admin screen: click Contact support on your Dashboard, or Help & support at the top of any admin page. See Getting help below.

## Getting help

**This guide in your portal.** Click **📘 Owner guide** on your Dashboard or at the top of any admin page. It opens the latest version of this guide, with a contents list to jump to any section. It's updated whenever Slotwise changes, so it always matches what you see.

**Opening a support case.** Click **Contact support** on your Dashboard (or **Help & support** at the top of any admin page). Then:

1. Pick what it's about (bookings, payments, your plan, emails and texts, your website, sign-in, or something else).
2. Check the **Email us back at** address. It's filled in with yours; change it if replies should go elsewhere.
3. Write a short subject and what's happening: what you were doing, what you expected, and what happened instead. Booking codes and exact error messages help a lot.
4. Click **Send to support**.

You get a **case number** (for example SW-1001) straight away, on screen and by email.

**Following up.** Each time support replies, you get an email with the reply and a link to the case. Your Dashboard also says "Support has replied". Reply on the case page to add details; replying to a resolved case reopens it. When your problem is fixed, click **It's sorted, close the case**. **Help & support** lists all your cases and their status: *With support*, *Support replied* or *Resolved*.

## How you're charged, and adding more or upgrading

**In short:** you pay Slotwise a monthly plan price, and each plan includes a set number of bookings a month. Your customers' payments are yours: they go straight to your own Stripe, Square or PayPal account and Slotwise takes nothing from them. If you need more bookings in a month, you add a pack or move to a bigger plan. You're warned well before you run out.

### What you pay

| Charge | When | How it's paid |
| --- | --- | --- |
| Your plan (Starter free, Pro $29, Business $79 a month) | Every month, on the date you first subscribed | Automatically, by the card you subscribed with |
| Booking packs you buy | Only when you click **Buy** | Once, by card on a secure checkout page |
| Auto top-ups (only if you turn it on) | Added to your next monthly plan invoice | The card on your plan |
| Your customers' payments | Never | They go to your own payment account; only that provider's card fees apply |

Prices are the defaults when this guide was written; **Plan & billing** always shows your current prices. Texts and emails to your customers aren't on your Slotwise bill either: they go through your own Twilio and email accounts, which charge you directly (most email accounts include sending at no extra cost).

### How bookings are counted

- Every booking counts once, when it's confirmed: online, by chat, in the app, or added by you in Bookings.
- Moving a booking to a new time or staff member doesn't count again.
- A booking that's later cancelled or marked no-show still counts.
- An online booking where the customer never finished paying doesn't count, and neither does a pay-in-person request until you accept it.
- The count restarts at zero on the 1st of every month. This is separate from your billing date: allowances always follow the calendar month.

Your running total is on the **Dashboard** and in **Plan & billing**, with how many are left and the reset date.

### The warnings you'll get

| When you reach | What happens |
| --- | --- |
| 80% | Every admin gets an email, and an amber banner appears at the top of every admin page |
| 90% | A second email, and the banner updates with how many are left |
| 100% | A final email and a red banner. New bookings pause, both online and ones you add yourself, until you add more, upgrade, or the month resets. Existing bookings, reschedules and cancellations still work |

Each email lists your options with prices, including the plan that would cover you. For example, on Pro (300 bookings): booking 240 sends the 80% warning, booking 270 the 90% warning, and booking 300 the last one.

### Your options when you're running low

| Option | Best when | What happens | Cost |
| --- | --- | --- | --- |
| Buy a booking pack | A one-off busy month | 50 extra bookings are added the moment payment goes through and last until the end of the month. Buy up to 10 packs at once. Unused bookings don't carry over | $10 per 50 |
| Auto top-up | You never want booking to pause | When you run out, 50 more are added automatically and you get an email each time | $10 each, on your next plan invoice. Paid plans only |
| Upgrade your plan | You run out most months | The bigger allowance applies straight away, including to this month | The new plan's monthly price |
| Do nothing | It's nearly the end of the month | Online booking pauses until the 1st | Nothing |

To buy a pack: **Plan & billing → Need more?**, choose how many, click **Buy** and pay. To turn on auto top-up: tick **Auto top-up** on the same page.

**Pack or upgrade? A rule of thumb.** On Starter, three packs ($30) cost more than Pro ($29), which includes 300 bookings. On Pro, five packs ($50) bring your month to $79, the same as Business with 2,000 bookings. If you're buying packs most months, upgrading is usually cheaper.

### Changing your plan

In **Plan & billing**, click **Switch to …** on the plan you want.

- **From Starter to a paid plan:** a secure card page opens. The new plan and its allowance start as soon as payment goes through, and you're billed monthly from that day.
- **Between paid plans:** the change is immediate and prorated. You're charged (or credited) the difference for the rest of your billing month on your next invoice.
- **Moving to a smaller paid plan:** the smaller allowance applies straight away. If you've already used more than it allows this month, new bookings pause until the 1st or until you add a pack.
- **Moving back to Starter:** you keep your paid plan, with all its bookings and features, until the end of the month you've already paid for. You aren't charged again, and you move to Starter on that date. Plan & billing shows the date, and a \*\*Keep\*\* button if you change your mind. Once Starter begins, auto top-up stops and the AI assistant switches off. Staff you already have stay bookable, but you can't add more than Starter allows.
- Packs you've already bought stay until the end of the month whichever plan you're on.

### Invoices, your card and failed payments

- **Manage billing & invoices** in Plan & billing (shown once you've subscribed to a paid plan) lets you update your card, download invoices and cancel. Cancelling there works the same as moving to Starter: your plan runs to the end of the paid month.
- **Extra uses added this month and before**, in Plan & billing, lists every pack and top-up with its date and price.
- **If your card can't be charged,** the payment is retried over the next few days. Update your card under Manage billing & invoices. If it still can't be charged, your paid plan ends and you move to Starter; your bookings are kept.
- **Something unusual,** such as a burst of spam bookings? Contact Slotwise support, who can add bookings to your month.
