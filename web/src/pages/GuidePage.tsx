import { useEffect, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Marked } from "marked";
import guide from "../content/owner-guide.md?raw";

/** Anchor ids from heading text, so the contents list (and shared links like /guide#getting-paid) can jump to a section. */
const slug = (text: string) => text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function render() {
  const sections: { id: string; title: string; depth: number }[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const id = slug(text);
        if (depth === 2 || depth === 3) sections.push({ id, title: text, depth });
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
    },
  });
  // Wide tables scroll inside their box on phones instead of widening the page.
  const html = (marked.parse(guide) as string).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return { html, sections };
}

/**
 * The business owner guide, built into the site so every owner always sees the current version.
 * Its text lives in web/src/content/owner-guide.md and ships with each update.
 */
export function GuidePage() {
  const { html, sections } = useMemo(render, []);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="container guide">
      <aside className="card guide-toc">
        <div className="small muted">Contents</div>
        {sections.filter((s) => s.depth === 2).map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
        <hr />
        <Link to="/admin" className="small">← Back to my admin</Link>
      </aside>
      <article className="card guide-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
