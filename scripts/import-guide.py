"""Turns a Claude Docs Markdown export of the business owner guide into web/src/content/owner-guide.md.

Usage: python3 scripts/import-guide.py <export.json or .md> [--date "October 20, 2026"]
The in-app guide (/guide) is built from that file, so committing it publishes the update.
"""
import base64, datetime, json, sys

src = sys.argv[1]
date = sys.argv[sys.argv.index("--date") + 1] if "--date" in sys.argv else datetime.date.today().strftime("%B %-d, %Y")
raw = open(src, encoding="utf-8").read()
if src.endswith(".md"):
    md = raw
else:
    def find(o):
        if isinstance(o, dict):
            for v in o.values():
                if (r := find(v)): return r
        elif isinstance(o, list):
            for v in o:
                if (r := find(v)): return r
        elif isinstance(o, str) and len(o) > 10000:
            return o
    md = base64.b64decode(find(json.loads(raw))).decode("utf-8")

lines = md.split("\n")
# The doc's byline ("Oct 19, 2026 · @Name") becomes a "last updated" line for owners.
if len(lines) > 2 and "·" in lines[2] and "@" in lines[2]:
    lines[2] = f"*Last updated {date}.*"
open("web/src/content/owner-guide.md", "w", encoding="utf-8").write("\n".join(lines).rstrip() + "\n")
print(f"owner-guide.md updated ({len(md)} characters, {sum(1 for l in lines if l.startswith('## '))} sections)")
