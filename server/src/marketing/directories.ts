import { one, run } from "../db.js";
import { productBrief, structured } from "./agent.js";
import { getSettings, logEvent, now } from "./store.js";

/**
 * Software directories and launch sites worth a listing. Each lists the fields its submission form asks for;
 * the agent writes copy for exactly those, and the super admin pastes it in and records the listing's URL.
 * Lengths are what reads well on each site ("aim for"), not limits checked against their forms.
 */
export interface DirectoryField { key: string; label: string; aim?: number; help: string }
export interface Directory { id: string; name: string; url: string; why: string; howTo: string; fields: DirectoryField[] }

const tagline = (aim: number): DirectoryField => ({ key: "tagline", label: "Tagline", aim, help: "One line saying what it is and who it's for" });
const shortDesc = (aim: number): DirectoryField => ({ key: "short_description", label: "Short description", aim, help: "A couple of plain sentences" });
const longDesc: DirectoryField = { key: "long_description", label: "Full description", aim: 1200, help: "Who it's for, the problem, what it does, how it's different. Short paragraphs" };
const features: DirectoryField = { key: "features", label: "Key features", help: "One per line, as short noun phrases" };
const categories: DirectoryField = { key: "categories", label: "Categories", help: "One per line, using the category names that site uses for booking/scheduling software" };
const reviewEmail: DirectoryField = { key: "review_request_email", label: "Review request email", help: "A short, honest note asking your customers for a review there (no incentives offered)" };
const alternatives: DirectoryField = { key: "alternatives", label: "Alternative to", help: "One per line: well-known products people would compare it with" };

export const DIRECTORIES: Directory[] = [
  {
    id: "capterra", name: "Capterra · GetApp · Software Advice", url: "https://www.capterra.com",
    why: "Where small businesses compare software. One free vendor listing (Gartner Digital Markets) shows on all three sites.",
    howTo: "On capterra.com, look for the link for software vendors (\"For Vendors\" / \"Get listed\"), create a free vendor account, and add your product. Free listings are fine; paid clicks are optional.",
    fields: [tagline(100), shortDesc(300), longDesc, features, categories, { key: "target_customers", label: "Typical customers", help: "One per line" }, reviewEmail],
  },
  {
    id: "g2", name: "G2", url: "https://www.g2.com",
    why: "Large review site that ranks well on Google for \"best … software\" searches. A free profile plus a handful of reviews gets you into its category pages.",
    howTo: "On g2.com, use the link for vendors to claim or create a free product profile. Then send the review email below to happy customers.",
    fields: [tagline(100), longDesc, features, categories, reviewEmail],
  },
  {
    id: "alternativeto", name: "AlternativeTo", url: "https://alternativeto.net",
    why: "People search for \"Calendly alternative\" or \"Vagaro alternative\" and land here. Listing Slotwise as an alternative to the big names puts it in front of people ready to switch.",
    howTo: "Sign in on alternativeto.net and use \"Add an app\". After it's approved, add Slotwise as an alternative on each product listed below.",
    fields: [shortDesc(300), longDesc, alternatives, { key: "tags", label: "Tags", help: "One per line, lowercase, e.g. appointment-booking" }, { key: "platforms", label: "Platforms", help: "One per line: Web, iPhone, Android… (only ones Slotwise really supports)" }],
  },
  {
    id: "producthunt", name: "Product Hunt", url: "https://www.producthunt.com",
    why: "A one-day launch that can bring a burst of visitors, early users, backlinks and press. Works best with a few friends and customers ready to comment that day.",
    howTo: "Create a maker account, then submit a new product and schedule the launch (they start at midnight Pacific time). Post the first comment yourself as soon as it goes live.",
    fields: [
      tagline(60), shortDesc(260),
      { key: "first_comment", label: "Your first (maker) comment", aim: 900, help: "Why you built it, who it's for, what's next, and a question to start conversation" },
      { key: "topics", label: "Topics", help: "One per line, e.g. Productivity, Small business, SaaS" },
      { key: "launch_checklist", label: "Launch-day checklist", help: "Short steps for the day before and the day of" },
    ],
  },
  {
    id: "saashub", name: "SaaSHub", url: "https://www.saashub.com",
    why: "Software directory focused on alternatives and comparisons; free listings rank on Google for \"X vs Y\" pages.",
    howTo: "On saashub.com use the option to submit a product (free).",
    fields: [tagline(80), shortDesc(300), longDesc, alternatives, categories],
  },
  {
    id: "sourceforge", name: "SourceForge (business software)", url: "https://sourceforge.net",
    why: "Besides open source, it runs a large business-software directory with comparison pages.",
    howTo: "On sourceforge.net, look for the option to list your business software (free vendor profile).",
    fields: [tagline(100), longDesc, features, categories],
  },
  {
    id: "trustradius", name: "TrustRadius", url: "https://www.trustradius.com",
    why: "Review site trusted by buyers; free vendor profile, and reviews from your customers show up in Google results.",
    howTo: "On trustradius.com use the link for vendors to claim or create your free product profile.",
    fields: [tagline(100), longDesc, features, categories, reviewEmail],
  },
  {
    id: "betalist", name: "BetaList", url: "https://betalist.com",
    why: "Features new startups to early adopters; good for a first wave of users and feedback.",
    howTo: "Submit your startup on betalist.com (free, with a waiting list; a paid option skips the wait).",
    fields: [tagline(80), { key: "pitch", label: "Pitch", aim: 500, help: "What it is, who it's for, why now" }],
  },
  {
    id: "indiehackers", name: "Indie Hackers", url: "https://www.indiehackers.com",
    why: "A community of founders. Sharing the honest story of building Slotwise gets feedback, goodwill and links back.",
    howTo: "Create a product page, then post the story below in the community. Share what you've learned, not just the product.",
    fields: [tagline(80), { key: "story_post", label: "Story post", aim: 1500, help: "Building Slotwise: why, what you learned, honest numbers you're happy to share, a question for readers" }],
  },
];

export const directory = (id: string) => DIRECTORIES.find((d) => d.id === id);

function schemaFor(d: Directory) {
  return {
    type: "object",
    properties: Object.fromEntries(d.fields.map((f) => [f.key, { type: "string", description: `${f.label}: ${f.help}${f.aim ? ` (aim for about ${f.aim} characters)` : ""}` }])),
    required: d.fields.map((f) => f.key),
    additionalProperties: false,
  };
}

/** Writes listing copy for one directory in the background; the row shows "drafting" until it's done. */
export function startListing(d: Directory, instruction?: string) {
  const existing = one("SELECT * FROM marketing_directories WHERE id = ?", d.id);
  if (existing?.status === "drafting") return false;
  run(`INSERT INTO marketing_directories (id, status, updated_at) VALUES (?, 'drafting', ?)
       ON CONFLICT(id) DO UPDATE SET status = 'drafting', error = NULL, updated_at = excluded.updated_at`, d.id, now());
  const previous = existing?.status && existing.status !== "drafting" ? existing.status : "todo";
  writeListing(d, instruction)
    .then((copy) => {
      if (!copy) throw new Error("The model declined or the answer was cut off; try again");
      // Keep "submitted"/"live" if you're refreshing copy for a listing that already exists.
      const status = ["submitted", "live"].includes(previous) ? previous : "ready";
      run("UPDATE marketing_directories SET status = ?, copy = ?, error = NULL, updated_at = ? WHERE id = ?", status, JSON.stringify(copy), now(), d.id);
      logEvent("directory", `Wrote listing copy for ${d.name}`, { url: d.url, level: "success" });
    })
    .catch((err) => {
      const msg = String((err as Error).message ?? err).slice(0, 500);
      run("UPDATE marketing_directories SET status = CASE WHEN copy IS NULL THEN 'todo' ELSE 'ready' END, error = ?, updated_at = ? WHERE id = ?", msg, now(), d.id);
      logEvent("error", `Couldn't write listing copy for ${d.name}: ${msg}`, { level: "error" });
    });
  return true;
}

async function writeListing(d: Directory, instruction?: string) {
  const s = getSettings();
  const system = `You write software directory listings for a small company. Listings must be accurate and specific,
because buyers compare products side by side and directories reject hype.

${productBrief(s)}

Rules:
- Only claim features in the product brief. Never invent customer numbers, ratings, awards, reviews or testimonials.
- Plain, concrete language a busy small-business owner understands. No buzzwords ("revolutionary", "seamless", "game-changing", "AI-powered" as filler).
- Fit each field to the site's style and the suggested length. For list fields, put one item per line with no bullets or numbering.
- Review request emails ask for an honest review, offer nothing in return, and are short and personal.
- When naming alternatives, use real, well-known products in the same space.`;
  const user = `Directory: ${d.name} (${d.url})
Why we're listing here: ${d.why}
Write every field below for this directory.
${d.fields.map((f) => `- ${f.key} — ${f.label}: ${f.help}${f.aim ? ` (about ${f.aim} characters)` : ""}`).join("\n")}${instruction ? `\n\nExtra instruction from the founder: ${instruction}` : ""}`;
  return structured<Record<string, string>>(s, system, user, schemaFor(d));
}
