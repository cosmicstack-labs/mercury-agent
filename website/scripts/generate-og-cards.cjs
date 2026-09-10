/**
 * Build-time OG card generator for Mercury Agent docs.
 *
 * Runs after `docusaurus build` produces static HTML. Walks the build
 * output, extracts each docs page's <title> and <meta description>,
 * renders a per-page SVG from the template, converts to PNG, and
 * drops it into the build's static img directory.
 *
 * Also renders the static home and cloud cards from their SVGs.
 *
 * Usage: node scripts/generate-og-cards.cjs
 * (called automatically by the postbuild step, or standalone)
 */
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const ogSrcDir = path.join(root, 'static', 'img', 'og');
const ogOutDir = path.join(buildDir, 'img', 'og');

const WIDTH = 1200;
const HEIGHT = 630;

// ── Helpers ──────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Embed the white logo PNG as a base64 <image> element for use inside SVGs.
// logo-dark.png is the white ☿ glyph (for dark backgrounds).
let logoBase64 = null;
function getLogoSvg() {
  if (logoBase64) return logoBase64;
  const logoPath = path.join(ogSrcDir, '..', 'logo-dark.png');
  if (!fs.existsSync(logoPath)) {
    // Fallback to gradient square
    return '<rect width="44" height="44" rx="10" fill="url(#logoGrad)"/>\n    <text x="22" y="33" font-family="serif" font-size="28" fill="white" text-anchor="middle">☿</text>';
  }
  const buf = fs.readFileSync(logoPath);
  const b64 = buf.toString('base64');
  // Scale the 500x500 logo down to 44x44
  logoBase64 = `<image x="0" y="0" width="44" height="44" href="data:image/png;base64,${b64}"/>`;
  return logoBase64;
}

function renderSvgToPng(svgPath, pngPath) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      loadSystemFonts: true,
    },
  });
  const png = resvg.render().asPng();
  fs.writeFileSync(pngPath, png);
}

// ── Static cards (home, cloud) ───────────────────────────────────

function renderStaticCards() {
  ensureDir(ogOutDir);
  const logoSvg = getLogoSvg();
  const statics = ['home', 'cloud'];
  for (const name of statics) {
    const svgPath = path.join(ogSrcDir, `${name}.svg`);
    const pngPath = path.join(ogOutDir, `${name}.png`);
    if (fs.existsSync(svgPath)) {
      let svg = fs.readFileSync(svgPath, 'utf8');
      svg = svg.replace('{{LOGO_SVG}}', logoSvg);
      fs.writeFileSync(svgPath, svg);
      renderSvgToPng(svgPath, pngPath);
      console.log(`  ✓ og/${name}.png`);
    }
  }
}

// ── Dynamic docs cards ──────────────────────────────────────────

/**
 * Escape text for SVG — handle &, <, >, and wrap long lines.
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wrap text into lines of at most maxChars, capped at maxLines.
 */
function wrapText(text, maxChars, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current) {
      lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines.slice(0, maxLines);
}

/**
 * Render title lines — first line white, wrapped lines accent gradient.
 */
function titleToSvg(lines, startY) {
  const fontSize = 56;
  const lineHeight = 68;
  let y = startY;
  let svg = '';
  for (let i = 0; i < lines.length; i++) {
    const fill = i === 0 ? '#ffffff' : 'url(#accent)';
    svg += `<text x="80" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="${fontSize}" font-weight="900" fill="${fill}" letter-spacing="-1.5">${escapeXml(lines[i])}</text>\n`;
    y += lineHeight;
  }
  return svg;
}

/**
 * Render description lines as gray subtext.
 */
function descToSvg(lines, startY) {
  let y = startY;
  let svg = '';
  for (const line of lines) {
    svg += `<text x="80" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="500" fill="#7a7a8a">${escapeXml(line)}</text>\n`;
    y += 28;
  }
  return svg;
}

/**
 * Strip HTML tags, decode common entities, and normalize whitespace.
 */
function cleanText(raw) {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a breadcrumb (e.g. "Releases") from the built page's URL path,
 * with a few friendly overrides for known sections.
 */
function breadcrumbFromPath(relPath) {
  const dir = path.dirname(relPath);
  if (dir === '.') return 'Documentation';
  const map = {
    releases: 'Release Notes',
    'getting-started': 'Getting Started',
    'cli-commands': 'CLI Reference',
    reference: 'Reference',
    integrations: 'Integrations',
    cloud: 'Mercury Cloud',
    'daemon-mode': 'Daemon Mode',
  };
  const seg = dir.split(path.sep)[0];
  return map[seg] || seg.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract the page's main h2 headings ("In this page" bullets).
 */
function extractHeadings(html) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)) {
    const text = cleanText(m[1]).replace(/​/g, ''); // strip zero-width anchors
    if (!text || text.length > 48 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Extract a tagline: frontmatter description meta, else the first
 * paragraph, else the first h2 (for pages with none).
 */
function extractDescription(html) {
  const meta = html.match(/<meta\s+(?:name=|data-rh="true"\s+name=)?"description"\s+content="([^"]*)"/);
  if (meta && meta[1].trim()) return meta[1].trim();

  // First non-empty <p> in the article body
  for (const m of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const text = cleanText(m[1]);
    if (text.length > 24) return text;
  }
  return '';
}

/**
 * Render the section breadcrumb as a subtle top-right label.
 */
function breadcrumbToSvg(breadcrumb) {
  const label = breadcrumb.toUpperCase();
  const width = Math.max(80, label.length * 9.5 + 32);
  const x = 1120 - width;
  return `<g transform="translate(${x}, 84)">
    <rect width="${width}" height="30" rx="8" fill="rgba(167,139,250,0.10)" stroke="rgba(167,139,250,0.25)"/>
    <text x="${width / 2}" y="20" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="700" fill="#a78bfa" text-anchor="middle" letter-spacing="1.5">${escapeXml(label)}</text>
  </g>`;
}

/**
 * Render up to 4 "In this page" section headings as bullet lines.
 */
function bulletsToSvg(headings, startY) {
  if (!headings.length) return '';
  let y = startY;
  let svg = `<text x="80" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="800" fill="#4a4a58" letter-spacing="2.5">IN THIS PAGE</text>\n`;
  y += 32;
  for (const h of headings) {
    svg += `<g>
      <circle cx="87" cy="${y - 6}" r="4" fill="url(#accent)"/>
      <text x="104" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="19" font-weight="500" fill="#8a8a9a">${escapeXml(h)}</text>
    </g>\n`;
    y += 33;
  }
  return svg;
}

function generateDocsCards() {
  const docsDir = path.join(buildDir, 'docs');
  if (!fs.existsSync(docsDir)) {
    console.log('  ⚠ build/docs/ not found — skipping dynamic docs cards');
    return;
  }

  const template = fs.readFileSync(path.join(ogSrcDir, 'docs-template.svg'), 'utf8');
  const logoSvg = getLogoSvg();
  let count = 0;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      // Skip non-docs pages (docusaurus root-level)
      if (fullPath.includes(path.sep + 'img' + path.sep)) continue;

      const html = fs.readFileSync(fullPath, 'utf8');

      // Extract title — Docusaurus puts the page title in <title>...</title>
      // or in <h1> for docs. The <title> tag usually has " — Mercury Agent" suffix.
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      let title = titleMatch ? titleMatch[1].replace(/\s*[—–-]\s*Mercury.*$/i, '').trim() : '';

      // If title is empty or just "Mercury Agent", try h1
      if (!title || title === 'Mercury Agent') {
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        if (h1Match) title = h1Match[1].trim();
      }

      if (!title) continue;

      // Compute the output path — mirror the docs URL structure
      const relPath = path.relative(docsDir, fullPath);
      const slug = relPath.replace(/\.html$/, '').replace(/\//g, '-');
      const pngName = `docs-${slug}.png`;
      const pngPath = path.join(ogOutDir, pngName);

      // Extract description from meta / first paragraph
      const desc = extractDescription(html);
      // Section headings for "In this page" bullets
      const headings = extractHeadings(html);
      // Breadcrumb from the URL path
      const breadcrumb = breadcrumbFromPath(relPath);

      // Computed adaptive layout — fits within the 630px canvas:
      // title (up to 2 lines) → description (up to 2 lines) →
      // "In this page" bullets (up to 4, only if there's room).
      const titleLines = wrapText(title, 38, 2);
      const descLines = wrapText(desc, 75, 2);
      const bulletBudget = 630 - 60; // bottom safe area

      let y = 252; // below logo + DOCS badge
      const titleSvg = titleToSvg(titleLines, y);
      y += titleLines.length * 68 + (titleLines.length ? 14 : 0);

      const descSvg = descToSvg(descLines, y);
      if (descLines.length) y += descLines.length * 28 + 30;

      const maxBullets = Math.max(0, Math.floor((bulletBudget - y - 60) / 33));
      const shownHeadings = headings.slice(0, Math.min(4, maxBullets));
      const bulletsSvg = bulletsToSvg(shownHeadings, y);

      const pageUrl = relPath.replace(/\.html$/, '');
      const breadcrumbSvg = breadcrumbToSvg(breadcrumb);

      const svg = template
        .replace('{{LOGO_SVG}}', logoSvg)
        .replace('{{TITLE_SVG}}', titleSvg)
        .replace('{{DESC_SVG}}', descSvg)
        .replace('{{BULLETS}}', bulletsSvg)
        .replace('{{BREADCRUMB}}', breadcrumbSvg)
        .replace('{{PAGE_URL}}', escapeXml(`mercuryagent.sh/docs/${pageUrl}`));

      // Write temp SVG, render to PNG
      const tempSvg = path.join(ogOutDir, '_temp.svg');
      fs.writeFileSync(tempSvg, svg);
      renderSvgToPng(tempSvg, pngPath);
      fs.unlinkSync(tempSvg);

      // Inject OG image meta tags into the built HTML
      const ogUrl = `https://mercuryagent.sh/img/og/${pngName}`;
      const urlPath = `/docs/${relPath.replace(/\.html$/, '')}`;
      const canonicalUrl = `https://mercuryagent.sh${urlPath}`;
      let updatedHtml = html;

      // Remove existing og:image, twitter:image, and twitter:card meta tags
      // Docusaurus minifies HTML, so tags may have varied attribute order and quoting
      updatedHtml = updatedHtml.replace(/<meta\s+[^>]*property=["']?og:image["']?[^>]*>/gi, '');
      updatedHtml = updatedHtml.replace(/<meta\s+[^>]*name=["']?twitter:image["']?[^>]*>/gi, '');
      updatedHtml = updatedHtml.replace(/<meta\s+[^>]*name=["']?twitter:card["']?[^>]*>/gi, '');

      // Insert our OG image tags + twitter card before </head>
      const ogTags = `<meta property="og:image" content="${ogUrl}" />\n    <meta name="twitter:card" content="summary_large_image" />\n    <meta name="twitter:image" content="${ogUrl}" />`;
      updatedHtml = updatedHtml.replace('</head>', `    ${ogTags}\n  </head>`);

      fs.writeFileSync(fullPath, updatedHtml);

      count++;
      console.log(`  ✓ og/${pngName}`);
    }
  }

  walk(docsDir);
  console.log(`  Generated ${count} docs cards`);
}

// ── Main ────────────────────────────────────────────────────────

console.log('Generating OG cards...');
ensureDir(ogOutDir);
renderStaticCards();
generateDocsCards();
console.log('Done.');