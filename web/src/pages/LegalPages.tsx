import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";

/**
 * Terms of Service and Privacy Policy. The wording is a template written around how Slotwise
 * actually works; the company details come from Super admin → Settings → Legal pages.
 */

interface Legal { companyName: string; contactEmail: string; address: string; governingLaw: string; effectiveDate: string }

function useLegal() {
  const { data } = useApi<Legal>("/public/legal");
  return {
    company: data?.companyName || "Slotwise",
    email: data?.contactEmail || "the support address shown in your portal",
    address: data?.address || "",
    law: data?.governingLaw || "the state in which the operator of Slotwise is based",
    date: data?.effectiveDate || "October 20, 2026",
    contactLink: data?.contactEmail ? <a href={`mailto:${data.contactEmail}`}>{data.contactEmail}</a> : <>us through the support link in your portal</>,
  };
}

function LegalShell({ title, date, children }: { title: string; date: string; children: ReactNode }) {
  return (
    <div className="container narrow legal">
      <p className="small"><Link to="/">← Slotwise</Link></p>
      <h1>{title}</h1>
      <p className="muted small">Effective {date}</p>
      {children}
      <hr />
      <p className="small muted"><Link to="/terms">Terms of Service</Link> · <Link to="/privacy">Privacy Policy</Link></p>
    </div>
  );
}

export function TermsPage() {
  const l = useLegal();
  return (
    <LegalShell title="Terms of Service" date={l.date}>
      <p>These terms are an agreement between you and {l.company} ("Slotwise", "we", "us") for using the Slotwise website, booking pages, embeds, mobile app and related services (the "Service"). By creating an account or booking through Slotwise, you agree to them. If you don't agree, please don't use the Service.</p>

      <h2>1. Who uses Slotwise</h2>
      <p><b>Businesses</b> (independent professionals, teachers, studios and other service providers) use Slotwise to take bookings. <b>Customers</b> use a business's booking page to book, move, cancel or pay for appointments. When you book with a business, your appointment is an agreement between you and that business. Slotwise provides the software but is not a party to it, and isn't responsible for the services the business provides, its prices, or its cancellation and refund decisions.</p>

      <h2>2. Accounts</h2>
      <ul>
        <li>You must be at least 18 (or the age of majority where you live) to create a business account. Customers under 18 should book with a parent or guardian.</li>
        <li>Give accurate information and keep your password safe. You're responsible for what happens under your account, including staff you invite.</li>
        <li>Tell us promptly at {l.contactLink} if you think your account has been used without permission.</li>
      </ul>

      <h2>3. Businesses' responsibilities</h2>
      <ul>
        <li>You're responsible for your services, prices, policies, availability and the information on your booking page, and for following the laws that apply to your business (including consumer, tax, privacy and anti-spam laws).</li>
        <li>You decide what customer information to collect and how to use it. You must have a lawful basis to use it, and only send customers marketing where they have agreed to it.</li>
        <li>Emails and text messages to your customers are sent through the email account, SMS provider (such as Twilio) and meeting tools you connect. You're responsible for those accounts, their terms and their costs, and for getting customers' consent to texts where the law requires it.</li>
        <li>Customer payments are taken through the payment provider you connect (such as Stripe, Square or PayPal), directly into your account with them. Refunds, chargebacks and disputes are between you, your customer and that provider. Slotwise never holds your customers' money.</li>
      </ul>

      <h2>4. Plans, fees and billing</h2>
      <ul>
        <li>Businesses can use a free plan or a paid plan. Plans include a monthly allowance of bookings and AI assistant use; prices and allowances are shown on the pricing section of our home page and in your portal's Billing tab.</li>
        <li>Paid plans are billed in advance each month through Stripe and renew automatically until cancelled. Extra booking packs and optional auto top-ups are charged when you buy them or when auto top-up runs.</li>
        <li>Upgrades take effect immediately and are prorated. Downgrades and cancellations take effect at the end of the period you've paid for, and you keep your current plan until then. Except where the law requires, fees already paid aren't refunded.</li>
        <li>We may change prices with at least 30 days' notice by email. Changes apply from your next billing period.</li>
        <li>If a payment fails, we may limit new bookings until it's resolved.</li>
      </ul>

      <h2>5. Recurring bookings</h2>
      <p>Where a business allows it, you can book the same time every week or every two weeks for a set number of weeks (26 by default). Each lesson is a separate booking that can be moved or cancelled under the business's normal cancellation policy. We'll remind you before the last lesson so you can renew; a series never renews without you or the business choosing to.</p>

      <h2>6. Acceptable use</h2>
      <p>Don't use the Service to break the law; to send spam or unwanted messages; to offer illegal, harmful or adult services; to harass anyone; to collect people's information without permission; to upload malware; or to probe, overload or get around the Service's security or limits. Don't resell the Service or copy it to build a competing product. We may remove content or suspend accounts that break these rules.</p>

      <h2>7. AI features</h2>
      <p>Slotwise includes optional AI features, such as a booking assistant that customers can chat with and a support assistant that helps us answer support cases. AI can make mistakes. The booking assistant acts only through the same booking rules as the booking page, and bookings it makes are confirmed by email. Don't rely on AI answers for medical, legal, financial or other professional advice. Support replies drafted by AI are reviewed by a person before they're sent.</p>

      <h2>8. Third-party services</h2>
      <p>The Service connects to other services you choose, such as Google Calendar, Microsoft Outlook, Zoom, RingCentral, payment providers and SMS providers. Your use of them is governed by their own terms and privacy policies. We aren't responsible for their availability or actions.</p>

      <h2>9. Your content</h2>
      <p>You keep ownership of the information you put into Slotwise (your business details, services, customer records and messages). You give us permission to store, process and display it only as needed to run, secure and improve the Service for you. We own the Slotwise software, brand and design.</p>

      <h2>10. Availability and changes</h2>
      <p>We work to keep Slotwise running reliably but can't promise it will always be available or error-free. We may change or discontinue features; if we make a change that significantly reduces what a paid plan includes, we'll tell you in advance.</p>

      <h2>11. Disclaimers</h2>
      <p>The Service is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement.</p>

      <h2>12. Limitation of liability</h2>
      <p>To the fullest extent the law allows, Slotwise won't be liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or bookings. Our total liability for any claim relating to the Service is limited to the greater of the fees you paid us in the 12 months before the claim and US $100. Some places don't allow these limits, so they may not all apply to you.</p>

      <h2>13. Indemnity</h2>
      <p>Businesses agree to defend and compensate Slotwise for claims arising from their services, their content, their dealings with customers, or their breach of these terms or the law.</p>

      <h2>14. Ending your account</h2>
      <p>You can stop using Slotwise at any time; paid plans can be cancelled from the Billing tab. We may suspend or close an account that breaks these terms, puts others at risk, or hasn't paid, and will give notice where reasonable. After an account closes we may delete its data as described in our <Link to="/privacy">Privacy Policy</Link>.</p>

      <h2>15. Governing law</h2>
      <p>These terms are governed by the laws of {l.law}, without regard to conflict-of-law rules. Disputes will be handled in the courts located there, unless the law where you live gives you the right to bring them elsewhere.</p>

      <h2>16. Changes to these terms</h2>
      <p>We may update these terms. If a change is significant, we'll tell businesses by email or in the portal at least 14 days before it takes effect. Continuing to use the Service after that means you accept the new terms.</p>

      <h2>17. Contact</h2>
      <p>Questions about these terms: {l.contactLink}.{l.address && <><br /><span style={{ whiteSpace: "pre-line" }}>{l.company}, {l.address}</span></>}</p>
    </LegalShell>
  );
}

export function PrivacyPage() {
  const l = useLegal();
  return (
    <LegalShell title="Privacy Policy" date={l.date}>
      <p>This policy explains what information Slotwise ({l.company}) collects, how it's used and shared, and the choices you have. It covers the Slotwise website, booking pages, embedded booking widgets and mobile app.</p>

      <h2>1. Two kinds of information</h2>
      <p><b>Business accounts.</b> For the business owners and staff who use Slotwise, we're responsible for their account information.</p>
      <p><b>Customers of a business.</b> When you book with a business through Slotwise, the business decides what to collect and how to use it. We store and process that information on the business's behalf, as its service provider (a "processor"). For questions about how a business uses your information, or to exercise your rights, contact the business first; we'll help it respond.</p>

      <h2>2. What we collect</h2>
      <ul>
        <li><b>Account details:</b> name, email address, password (stored only as a secure hash), and, if you sign in with Google, Apple or Microsoft, your name, email and account ID from that provider.</li>
        <li><b>Business details:</b> business name, address, phone, services, prices, staff, opening hours and settings.</li>
        <li><b>Booking details:</b> the customer's name, email, phone number (if given), the appointment, notes they add, whether they've agreed to text messages, and booking history.</li>
        <li><b>Payment details:</b> payments are handled by Stripe, Square or PayPal. We receive the payment status, amount and a reference, never full card numbers.</li>
        <li><b>Messages:</b> emails and texts sent about bookings, replies to texts, AI chat conversations on a booking page, and support cases.</li>
        <li><b>Connected accounts:</b> if a business connects a calendar, meeting tool, payment provider, email account or SMS provider, we store the access tokens or keys needed to use it, encrypted.</li>
        <li><b>Technical information:</b> server logs with IP address, browser type and the pages requested, used for security and fixing problems.</li>
      </ul>

      <h2>3. How we use it</h2>
      <ul>
        <li>To run bookings: showing availability, confirming, reminding, rescheduling and cancelling appointments, and sending calendar invites and meeting links.</li>
        <li>To bill businesses for their plan and usage, and to send account, usage and billing notices.</li>
        <li>To provide support, and to keep the Service secure, prevent abuse and fix problems.</li>
        <li>To improve Slotwise, using aggregated information that doesn't identify customers.</li>
      </ul>
      <p>We don't sell personal information, don't share it for cross-context behavioural advertising, and don't use customers' information to market our own services to them.</p>

      <h2>4. Who we share it with</h2>
      <p>We share information only with the service providers that help run Slotwise, with services a business chooses to connect, or when the law requires it:</p>
      <ul>
        <li><b>Hosting:</b> Render (servers and storage).</li>
        <li><b>Email:</b> Resend or Postmark for Slotwise's own emails; the business's own email account for emails to its customers.</li>
        <li><b>Platform billing:</b> Stripe.</li>
        <li><b>AI:</b> Anthropic, which processes booking-assistant chats and support cases when those features are switched on. Anthropic doesn't use this information to train its models under its commercial terms.</li>
        <li><b>Sign-in and calendars:</b> Google, Microsoft and Apple, when you choose to use them.</li>
        <li><b>Services a business connects:</b> such as its payment provider (Stripe, Square, PayPal), SMS provider (Twilio), and meeting tools (Google Meet, Microsoft Teams, Zoom, RingCentral). When you book with that business, the details needed for that service (for example your name and email on a meeting invite) are shared with it.</li>
        <li><b>The business you book with</b> sees your booking details, and its staff may see them in the Slotwise portal.</li>
        <li><b>Legal reasons:</b> if required by law, or to protect the rights and safety of people or the Service; and to a buyer if Slotwise is sold, under this policy.</li>
      </ul>

      <h2>5. Google user data</h2>
      <p>If a business connects Google Calendar, Slotwise uses Google's free/busy information to avoid double bookings, and creates, updates and removes events for Slotwise bookings. We use Google sign-in only to identify you. Slotwise's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. We don't use Google user data for advertising, don't sell it, don't let people read it except where needed for security, support you've asked for, or the law, and don't use it to train AI models. You can disconnect Google at any time from the Calendar sync tab, or at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">myaccount.google.com/permissions</a>.</p>

      <h2>6. Text messages</h2>
      <p>Customers get texts only if they tick the box agreeing to them when booking. Message frequency varies with your bookings (typically a confirmation, reminders and replies). Message and data rates may apply. Reply STOP to opt out or HELP for help. Phone numbers and consent aren't shared with third parties for their marketing.</p>

      <h2>7. Cookies and storage</h2>
      <p>Slotwise doesn't use advertising or tracking cookies. Your browser stores a sign-in token (in local storage) to keep you signed in, and a booking-page chat keeps its conversation ID until you close the tab. Embedded booking widgets on a business's website work the same way. The business's own website may use its own cookies, which its privacy policy covers.</p>

      <h2>8. How long we keep it</h2>
      <p>We keep account and booking information while a business's account is active, so the business has its booking history. When a business closes its account, we delete or anonymise its data within 90 days, unless we need to keep some of it longer for legal, tax, accounting or security reasons. Server logs are kept for a limited period. Backups are overwritten on a rolling basis.</p>

      <h2>9. Security</h2>
      <p>We use HTTPS for all traffic, store passwords as salted hashes, and encrypt connected-account tokens and keys at rest. Access to production systems is limited. No system is perfectly secure; if we learn of a breach that affects your information, we'll tell you as the law requires.</p>

      <h2>10. Your choices and rights</h2>
      <ul>
        <li>Customers can view, move or cancel their bookings from the link in their confirmation email, and stop texts by replying STOP.</li>
        <li>Business owners can update their information in the portal and close their account by contacting us.</li>
        <li>Depending on where you live (for example under the GDPR in the UK and EU, or state laws such as California's CCPA), you may have the right to access, correct, delete or get a copy of your information, to object to or limit certain uses, and to complain to a data protection authority. We won't treat you differently for using these rights.</li>
      </ul>
      <p>To make a request, contact {l.contactLink}. If your information was collected by a business you booked with, we may pass your request to that business.</p>

      <h2>11. International transfers</h2>
      <p>Slotwise and its service providers are based in the United States, so your information may be processed there. Where the law requires, we rely on appropriate safeguards such as standard contractual clauses.</p>

      <h2>12. Children</h2>
      <p>Slotwise isn't directed at children under 13, and we don't knowingly collect their information. A parent or guardian should make bookings for a child (for example for music lessons), and only the information needed for the booking should be given. If you think a child has given us information, contact us and we'll delete it.</p>

      <h2>13. Changes</h2>
      <p>We'll post any changes here and update the effective date. If a change is significant, we'll tell business owners by email or in the portal before it takes effect.</p>

      <h2>14. Contact</h2>
      <p>Privacy questions or requests: {l.contactLink}.{l.address && <><br /><span style={{ whiteSpace: "pre-line" }}>{l.company}, {l.address}</span></>}</p>
    </LegalShell>
  );
}
