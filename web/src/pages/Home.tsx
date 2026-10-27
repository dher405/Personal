import { useState } from "react";
import { Link } from "react-router-dom";
import { money } from "../api";
import { useAuth } from "../auth";
import { useApi } from "../hooks";

const WHO = [
  { icon: "🎹", title: "Music & language teachers", text: "Trial lessons, weekly students and make-up sessions, without the back-and-forth texts." },
  { icon: "📚", title: "Tutors & coaches", text: "Parents book after school, pay a deposit, and get a reminder the night before." },
  { icon: "🏋️", title: "Trainers & instructors", text: "Fill every open slot in your week, in the gym, in the park or on video." },
  { icon: "🧰", title: "Independent contractors", text: "Estimates, consultations and site visits, booked straight into your calendar." },
  { icon: "💇", title: "Salons, barbers & beauty", text: "A chair that books itself, with each stylist's own hours and services." },
  { icon: "🧘", title: "Wellness & therapy", text: "Calm, private booking for sessions in your studio or online." },
];

const FEATURES = [
  { icon: "🗓️", title: "A booking page that's always open", text: "Customers see only the times you're actually free, pick a service and book in about a minute, day or night." },
  { icon: "💬", title: "An AI assistant that books for you", text: "\"Anything Thursday after school?\" It answers, offers real open times and books, on your page and by text." },
  { icon: "📱", title: "Reminders customers can reply to", text: "Texts from your own number. Customers reply C to confirm, R to reschedule or X to cancel, and your calendar updates itself." },
  { icon: "💳", title: "Get paid up front, or in person", text: "Take full payment or a deposit through your own Stripe, Square or PayPal, or let customers ask to pay cash." },
  { icon: "🔄", title: "Works with the calendar you already use", text: "Bookings appear in Google Calendar or Outlook instantly, and your personal events block those times." },
  { icon: "🎥", title: "In person or online", text: "Online sessions get a Google Meet, Teams, Zoom or RingCentral link automatically, in every invite." },
  { icon: "✉️", title: "Emails from your own address", text: "Confirmations with a calendar invite, sent from your email, so replies come straight back to you." },
  { icon: "👥", title: "Room to grow", text: "Add staff with their own hours and services, and run several locations from one account." },
  { icon: "📲", title: "Run it from your phone", text: "See the day ahead, move a booking or text a customer from the app, wherever you are." },
];

const STEPS = [
  { n: "1", title: "Add what you offer", text: "Your services or lessons, prices, and the hours you want to work." },
  { n: "2", title: "Share your link", text: "Paste one line onto your website, or add your link to Instagram, Google and your email signature." },
  { n: "3", title: "Get booked", text: "Customers book, pay and get reminders. You get a text, and it's already in your calendar." },
];

const PLACES = ["WordPress", "Wix", "Squarespace", "Shopify", "GoDaddy", "Any website", "Instagram", "Facebook", "TikTok", "Google Business Profile", "Email signature", "QR code"];

const DAY = [
  { time: "7:00 am", text: "Your day's agenda arrives by text before your coffee's ready." },
  { time: "12:30 pm", text: "A student moves next week's lesson by replying R, and picks a new time. You didn't lift a finger." },
  { time: "4:15 pm", text: "Three of tomorrow's customers have already replied C to confirm, so you know exactly who's coming." },
  { time: "9:40 pm", text: "A parent finds you on Instagram, books a trial lesson and pays the deposit while you're off the clock." },
];

/** A small, live-looking preview of a booking page for the hero. */
function BookingPreview() {
  const days = [["Mon", "12"], ["Tue", "13"], ["Wed", "14"], ["Thu", "15"], ["Fri", "16"]];
  return (
    <div className="lp-preview" aria-hidden="true">
      <div className="lp-preview-head">
        <div className="lp-avatar">MS</div>
        <div><strong>Maple Street Studio</strong><div className="small muted">Piano · Guitar · Voice</div></div>
      </div>
      <div className="lp-pills"><span className="on">Piano lesson · 45 min</span><span>Free trial</span></div>
      <div className="lp-days">{days.map(([d, n], i) => <span key={d} className={i === 2 ? "on" : ""}><small>{d}</small>{n}</span>)}</div>
      <div className="lp-slots">{["3:00", "3:45", "4:30", "5:15", "6:00", "6:45"].map((t, i) => <span key={t} className={i === 2 ? "on" : ""}>{t}</span>)}</div>
      <div className="lp-toast">✅ <div><strong>You're booked!</strong><div className="small">Wed 4:30 pm · reminder set · added to calendar</div></div></div>
    </div>
  );
}

/** The public home page: what Slotwise is, who it's for, and how to start (or sign in). */
export function Home() {
  const { session } = useAuth();
  const { data: plans } = useApi<any[]>("/public/plans");
  const [q, setQ] = useState("");
  const { data: businesses } = useApi<any[]>(q.trim().length > 1 ? `/public/businesses?q=${encodeURIComponent(q)}` : null);
  const isOwner = session && ["admin", "superadmin"].includes(session.user.role);
  const { data: showcase } = useApi<{ name: string; slug: string } | null>("/public/showcase");

  return (
    <div className="lp">
      {/* Business owners find their way in first. */}
      <div className="lp-signin-strip">
        <div className="lp-wrap">
          {isOwner
            ? <>Welcome back{session.user.name ? `, ${session.user.name.split(" ")[0]}` : ""}! <Link to={session.user.role === "superadmin" ? "/super" : "/admin"}><b>Go to your admin →</b></Link></>
            : <>Already on Slotwise? <Link to="/login?next=/admin"><b>Business owner sign in →</b></Link></>}
        </div>
      </div>

      <section className="lp-hero">
        <div className="lp-wrap lp-hero-grid">
          <div>
            <div className="lp-eyebrow">Online booking for independent pros</div>
            <h1>Fill your calendar.<br /><span className="lp-gradient-text">Get your evenings back.</span></h1>
            <p className="lp-lead">
              Slotwise gives teachers, tutors, coaches and independent contractors a beautiful booking page, reminders that
              cut no-shows, payments, and an AI assistant that books for you, so you can spend your time doing the work you love.
            </p>
            <div className="lp-cta-row">
              <Link className="btn primary lp-btn-big" to="/register?provider=1">Start free, no card needed</Link>
              {isOwner
                ? <Link className="btn lp-btn-big" to={session.user.role === "superadmin" ? "/super" : "/admin"}>Go to your admin</Link>
                : <Link className="btn lp-btn-big" to="/login?next=/admin">Business sign in</Link>}
            </div>
            <ul className="lp-checks">
              <li>Set up in about 15 minutes</li>
              <li>{plans?.find((p) => !p.monthlyPriceCents) ? `Free for up to ${plans.find((p) => !p.monthlyPriceCents)!.bookingsPerMonth} bookings a month` : "Start on the free plan"}</li>
              <li>Works on any website and social profile</li>
            </ul>
            {showcase && <p className="small" style={{ marginTop: 14 }}><a href="#demo"><b>Try booking a lesson as a customer →</b></a></p>}
          </div>
          <BookingPreview />
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <h2>Made for people who teach, coach and serve</h2>
            <p>If people book time with you, Slotwise is for you: solo or with a small team, in person or online.</p>
          </div>
          <div className="lp-grid-3">
            {WHO.map((w) => (
              <div key={w.title} className="lp-card">
                <div className="lp-icon">{w.icon}</div>
                <h3>{w.title}</h3>
                <p>{w.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-tinted">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <h2>What success looks like</h2>
            <p>Less admin, fewer empty slots, and customers who show up ready. Here's an ordinary day with Slotwise working for you.</p>
          </div>
          <div className="lp-day">
            {DAY.map((d) => (
              <div key={d.time} className="lp-day-item">
                <div className="lp-day-time">{d.time}</div>
                <div>{d.text}</div>
              </div>
            ))}
          </div>
          <div className="lp-outcomes">
            <div><strong>Booked 24/7</strong><span>Your page takes bookings while you teach, sleep or travel.</span></div>
            <div><strong>Fewer no-shows</strong><span>Reminders customers confirm with one reply.</span></div>
            <div><strong>Paid up front</strong><span>Deposits and payments collected when they book.</span></div>
            <div><strong>Hours back</strong><span>No more back-and-forth to find a time that works.</span></div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="features">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <h2>Everything you need to run your bookings</h2>
            <p>Powerful where it counts, simple everywhere else.</p>
          </div>
          <div className="lp-grid-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="lp-card lp-feature">
                <div className="lp-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {showcase && (
        <section className="lp-section" id="demo">
          <div className="lp-wrap lp-two lp-demo">
            <div>
              <div className="lp-section-head left">
                <div className="lp-eyebrow">Live demo</div>
                <h2>Try it as a customer</h2>
                <p>This is a real Slotwise booking calendar for a sample music school, {showcase.name}, embedded just as it would be on your own website. Go ahead and book a lesson.</p>
              </div>
              <ul className="lp-checks lp-demo-list">
                <li>Pick a lesson, a teacher and a time</li>
                <li>Try paying: it's a test payment, so nothing is charged</li>
                <li>Then move or cancel it from the confirmation page</li>
                <li>Ask the "Book by chat" assistant on the full page</li>
              </ul>
              <p className="small muted">It's a sandbox: no emails or texts are sent, and demo bookings are cleared after a few hours.</p>
              <div className="lp-cta-row">
                <a className="btn lp-btn-big" href={`/b/${showcase.slug}`} target="_blank" rel="noreferrer">Open the full booking page ↗</a>
                <Link className="btn primary lp-btn-big" to="/register?provider=1">Make one like it</Link>
              </div>
            </div>
            <div className="lp-demo-frame">
              <div className="lp-code-bar"><i /><i /><i /><span>riversidemusic.example</span></div>
              <iframe title={`${showcase.name} booking demo`} src={`/embed/${showcase.slug}`} loading="lazy" />
            </div>
          </div>
        </section>
      )}

      <section className="lp-section lp-tinted">
        <div className="lp-wrap lp-two">
          <div>
            <div className="lp-section-head left">
              <h2>Live in 15 minutes. Really.</h2>
              <p>No designers, no developers, no code to write. Slotwise walks you through it, and your page is ready to share.</p>
            </div>
            <div className="lp-steps">
              {STEPS.map((s) => (
                <div key={s.n} className="lp-step"><div className="lp-step-n">{s.n}</div><div><h3>{s.title}</h3><p>{s.text}</p></div></div>
              ))}
            </div>
          </div>
          <div>
            <div className="lp-code">
              <div className="lp-code-bar"><i /><i /><i /><span>yourwebsite.com</span></div>
              <pre>{`<script src="…/embed.js"
  data-business="your-studio"
  async></script>`}</pre>
              <div className="small">Paste it once and your live calendar appears on your site. Prefer a button or a floating "Book now"? Pick a style and copy.</div>
            </div>
            <div className="lp-places">
              <div className="small muted">Add your booking to</div>
              <div className="lp-chips">{PLACES.map((p) => <span key={p}>{p}</span>)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="pricing">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <h2>Simple pricing that grows with you</h2>
            <p>Pay for the bookings you take. Your customers' payments are yours: no cut, no per-payment fees.</p>
          </div>
          <div className="lp-plans">
            {(plans ?? []).map((p, i) => (
              <div key={p.id} className={`lp-plan ${i === 1 ? "featured" : ""}`}>
                {i === 1 && <div className="lp-plan-tag">Most popular</div>}
                <h3>{p.name}</h3>
                <div className="lp-price">{p.monthlyPriceCents ? <>{p.monthlyPriceCents % 100 ? money(p.monthlyPriceCents) : `$${p.monthlyPriceCents / 100}`}<small>/month</small></> : "Free"}</div>
                <ul>
                  <li><b>{p.bookingsPerMonth.toLocaleString()}</b> bookings a month</li>
                  <li>Up to {p.maxStaff} staff</li>
                  <li>{p.aiChat ? `AI booking assistant (${p.aiMessagesPerMonth.toLocaleString()} replies)` : "Booking page, reminders & payments"}</li>
                  <li>Website embed & calendar sync</li>
                </ul>
                <Link className={`btn ${i === 1 ? "primary" : ""}`} to="/register?provider=1">{p.monthlyPriceCents ? `Choose ${p.name}` : "Start free"}</Link>
              </div>
            ))}
          </div>
          <p className="lp-fineprint">Need more in a busy month? Add bookings any time, or upgrade. We'll warn you well before you run out.</p>
        </div>
      </section>

      <section className="lp-section lp-tinted" id="find">
        <div className="lp-wrap lp-find">
          <div>
            <h2>Looking to book someone?</h2>
            <p className="muted">Search for a teacher, coach or business that uses Slotwise.</p>
          </div>
          <div>
            <input placeholder="Search by name or category (e.g. piano, tutoring, haircut)" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="lp-results">
              {businesses?.map((b) => (
                <Link key={b.slug} to={`/b/${b.slug}`} className="lp-result">
                  <strong>{b.name}</strong><span className="small muted">{[b.category, b.address].filter(Boolean).join(" · ")}</span>
                </Link>
              ))}
              {businesses?.length === 0 && <p className="muted small">No businesses found.</p>}
            </div>
          </div>
        </div>
      </section>

      <section className="lp-final">
        <div className="lp-wrap">
          <h2>Your next booking could happen tonight.</h2>
          <p>Set up your page in minutes and let Slotwise handle the scheduling, reminders and payments.</p>
          <div className="lp-cta-row center">
            <Link className="btn lp-btn-big lp-btn-light" to="/register?provider=1">Start free today</Link>
            {!isOwner && <Link className="btn lp-btn-big lp-btn-ghost" to="/login?next=/admin">Business sign in</Link>}
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <span className="brand-inline"><img src="/logo.svg" alt="" width={20} height={20} /><b>Slotwise</b> · Online booking for independent pros</span>
          <span className="lp-footer-links">
            <a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#find">Find a business</a>
            <Link to="/login?next=/admin">Business sign in</Link><Link to="/register?provider=1">Create your page</Link>
            <a href="/blog">Blog</a><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
