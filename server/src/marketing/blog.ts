import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { Marked } from "marked";
import { config } from "../config.js";
import { all, one } from "../db.js";

/**
 * The public blog at /blog: articles the super admin published from Marketing → Blog drafts.
 * Pages are rendered on the server (full HTML, title, description, canonical link, structured data)
 * so search engines read them without running the React app.
 */
export const publicBlogRouter = Router();

/** Splits the "---\nkey: value\n---" header the article writer puts at the top. */
export function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: md.slice(m[0].length) };
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const safeUrl = (href: string) => (/^(https?:|mailto:|\/|#)/i.test(href.trim()) ? href.trim() : "#");

/**
 * Markdown → HTML for article text. Articles are AI-written from questions found online, so raw HTML is shown
 * as text (never run) and links may only be http(s), mailto, or on this site.
 */
const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const url = safeUrl(href);
      const external = /^https?:/i.test(url) && !url.startsWith(config.webUrl);
      return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""}${external ? ' rel="nofollow noopener" target="_blank"' : ""}>${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, title, text }) {
      return `<img src="${esc(safeUrl(href))}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy">`;
    },
  },
});
export const renderMarkdown = (md: string) => markdown.parse(parseFrontMatter(md).body, { async: false }) as string;

// The website's stylesheet (its file name changes with every build), so blog pages look like the rest of the site.
let styles: string | null = null;
function siteStyles() {
  if (styles !== null) return styles;
  try {
    const html = readFileSync(fileURLToPath(new URL("../../../web/dist/index.html", import.meta.url)), "utf8");
    styles = (html.match(/<link rel="stylesheet"[^>]*>/g) ?? []).join("\n");
  } catch {
    styles = "";
  }
  return styles;
}

const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

function page(opts: { title: string; description: string; path: string; body: string; jsonLd?: object; type?: string }) {
  const url = `${config.webUrl}${opts.path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${opts.type ?? "website"}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
${siteStyles()}
${opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
<style>
  .blog { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  .blog article { line-height: 1.7; font-size: 1.05rem; }
  .blog article h1 { font-size: 2rem; margin: 8px 0 12px; }
  .blog article h2 { font-size: 1.4rem; margin: 32px 0 8px; }
  .blog article h3 { font-size: 1.15rem; margin: 24px 0 6px; }
  .blog article img { max-width: 100%; height: auto; }
  .blog article table { margin: 16px 0; }
  .blog article pre { overflow-x: auto; }
  .blog .meta { color: var(--muted, #666); font-size: .9rem; }
  .blog .post-list a.post { display: block; padding: 18px 0; border-bottom: 1px solid var(--border, #e2e5ea); color: inherit; text-decoration: none; }
  .blog .post-list a.post:hover h2 { text-decoration: underline; }
  .blog .post-list h2 { margin: 0 0 4px; font-size: 1.25rem; }
  .blog .cta { margin-top: 40px; padding: 20px; border: 1px solid var(--border, #e2e5ea); border-radius: 12px; background: var(--surface, #fff); }
</style>
</head>
<body>
<header class="topbar"><div class="container"><a href="/" class="brand">Slotwise</a><div class="spacer"></div><a href="/blog">Blog</a><a href="/register?provider=1" class="btn primary">List your business</a></div></header>
<main class="blog">${opts.body}</main>
</body>
</html>`;
}

const PUBLISHED = "status = 'published' AND on_site = 1";

publicBlogRouter.get("/blog", (_req, res) => {
  const posts = all(`SELECT title, slug, description, published_at FROM marketing_articles WHERE ${PUBLISHED} ORDER BY published_at DESC`);
  const list = posts.length
    ? posts.map((p) => `<a class="post" href="/blog/${esc(p.slug)}"><h2>${esc(p.title)}</h2><div class="meta">${fmtDate(p.published_at)}</div>${p.description ? `<p>${esc(p.description)}</p>` : ""}</a>`).join("")
    : `<p class="meta">No articles yet.</p>`;
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(page({
    title: "Slotwise blog: tips for running an appointment-based business",
    description: "Practical guides on online booking, scheduling, reminders and running an appointment-based business.",
    path: "/blog",
    body: `<h1>Blog</h1><div class="post-list">${list}</div>`,
  }));
});

publicBlogRouter.get("/blog/:slug", (req, res) => {
  const a = one(`SELECT * FROM marketing_articles WHERE slug = ? AND ${PUBLISHED}`, req.params.slug);
  // A real 404 (not the website's "page not found" screen, which answers 200) so search engines drop unpublished articles.
  if (!a) {
    return res.status(404).send(page({
      title: "Article not found | Slotwise", description: "This article isn't available.", path: "/blog",
      body: `<h1>Article not found</h1><p>It may have been moved or taken down. <a href="/blog">See all articles</a>.</p>`,
    }));
  }
  const { meta } = parseFrontMatter(a.body);
  const description = a.description || meta.description || "";
  const url = `${config.webUrl}/blog/${a.slug}`;
  let html = renderMarkdown(a.body);
  // The article's own first heading is the page title; avoid showing the title twice.
  html = html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>/, "");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(page({
    title: `${a.title} | Slotwise`,
    description,
    path: `/blog/${a.slug}`,
    type: "article",
    jsonLd: {
      "@context": "https://schema.org", "@type": "BlogPosting", headline: a.title, description,
      datePublished: new Date(a.published_at * 1000).toISOString(),
      dateModified: new Date((a.updated_at ?? a.published_at) * 1000).toISOString(),
      mainEntityOfPage: url, publisher: { "@type": "Organization", name: "Slotwise", url: config.webUrl },
    },
    body: `<p class="meta"><a href="/blog">← All articles</a></p>
<article><h1>${esc(a.title)}</h1><p class="meta">${fmtDate(a.published_at)}</p>${html}</article>
<div class="cta"><b>Try Slotwise free.</b> A booking page, text reminders and online payments for your business, set up in minutes.
<div style="margin-top:12px"><a class="btn primary" href="/register?provider=1">Create your booking page</a></div></div>`,
  }));
});

/** Every public page search engines should know about, including each published article. */
publicBlogRouter.get("/sitemap.xml", (_req, res) => {
  const base = config.webUrl;
  const posts = all(`SELECT slug, COALESCE(updated_at, published_at) AS t FROM marketing_articles WHERE ${PUBLISHED} ORDER BY published_at DESC`);
  const urls = [
    { loc: `${base}/` }, { loc: `${base}/blog` }, { loc: `${base}/guide` }, { loc: `${base}/terms` }, { loc: `${base}/privacy` },
    ...posts.map((p) => ({ loc: `${base}/blog/${p.slug}`, lastmod: new Date(p.t * 1000).toISOString().slice(0, 10) })),
  ];
  res.type("application/xml").setHeader("Cache-Control", "public, max-age=3600");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${"lastmod" in u ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`);
});

/** Lets search engines in, keeps them out of private areas, and points them at the sitemap. */
publicBlogRouter.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send(`User-agent: *
Disallow: /api/
Disallow: /admin
Disallow: /super
Disallow: /me
Disallow: /account
Disallow: /manage/
Disallow: /reset-password
Disallow: /auth/
Allow: /

Sitemap: ${config.webUrl}/sitemap.xml
`);
});
