// Renders the legal copy in legal.js into standalone static pages at dist/privacy/index.html and
// dist/terms/index.html, so they get real URLs (…/privacy, …/terms) rather than living behind a hash.
// A static host serves <dir>/index.html for a bare directory path, which is what makes the clean URL work.
//
// These are plain HTML on purpose: the legal text has no interactivity, so shipping the ~640 KB React
// bundle three times over would be pure waste. They inherit the app's palette so they don't feel bolted on.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGAL_PAGES, SITE_NAME } from "../legal.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// the app's palette, so the pages look like part of the same site
const C = { bg: "#0B1418", panel: "#0F1D22", ink: "#E8F1F2", mute: "#7C9AA3", teal: "#5FB0A6", line: "#26424B" };

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const render = (page, others) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(page.title)} · ${esc(SITE_NAME)}</title>
<meta name="description" content="${esc(page.summary)}" />
<meta name="robots" content="index, follow" />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: ${C.bg}; }
  body {
    color: ${C.ink};
    font-family: 'Space Grotesk', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    line-height: 1.65;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  a { color: ${C.teal}; }
  a:focus-visible { outline: 2px solid ${C.teal}; outline-offset: 2px; border-radius: 3px; }
  .back { display: inline-block; font-size: 13px; margin-bottom: 26px; text-decoration: none; }
  .back:hover { text-decoration: underline; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; }
  .summary { color: ${C.mute}; font-size: 14px; margin: 0 0 6px; }
  .updated { color: ${C.mute}; font-size: 12px; margin: 0 0 28px; }
  h2 { font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: ${C.teal};
       margin: 30px 0 8px; }
  p { font-size: 14.5px; margin: 0 0 12px; color: ${C.ink}; }
  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid ${C.line};
           font-size: 12.5px; color: ${C.mute}; }
  footer a { margin-right: 14px; }
</style>
</head>
<body>
  <main class="wrap">
    <a class="back" href="../">← Back to the calculator</a>
    <h1>${esc(page.title)}</h1>
    <p class="summary">${esc(page.summary)}</p>
    <p class="updated">Last updated ${new Date().toISOString().slice(0, 10)}</p>
${page.sections.map((s) => `    <h2>${esc(s.heading)}</h2>\n${s.paragraphs.map((t) => `    <p>${esc(t)}</p>`).join("\n")}`).join("\n")}
    <footer>
      <a href="../">Calculator</a>${others.map((o) => `<a href="../${o.slug}/">${esc(o.title)}</a>`).join("")}
    </footer>
  </main>
</body>
</html>
`;

for (const page of LEGAL_PAGES) {
  const dir = join(DIST, page.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), render(page, LEGAL_PAGES.filter((o) => o !== page)), "utf8");
  console.log(`  legal page → dist/${page.slug}/index.html`);
}
