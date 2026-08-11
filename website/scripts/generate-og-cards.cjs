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
 * Wrap a title into up to 3 lines that fit within maxWidth at the
 * given font size. Returns SVG <text> elements positioned correctly.
 */
function titleToSvg(title, startY) {
  const fontSize = 56;
  const maxChars = 38; // approximate chars per line at 1200px width
  const words = title.split(/\s+/);
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

  const lineHeight = 68;
  let y = startY;
  let svg = '';
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    const fill = i === 0 ? '#ffffff' : 'url(#accent)';
    svg += `<text x="80" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="${fontSize}" font-weight="900" fill="${fill}" letter-spacing="-1.5">${escapeXml(lines[i])}</text>\n`;
    y += lineHeight;
  }
  return { svg, nextY: y };
}

/**
 * Render a description as a gray subtext line, truncating if too long.
 */
function descToSvg(desc, y) {
  if (!desc) return '';
  const maxChars = 75;
  let text = desc;
  if (text.length > maxChars * 2) text = text.slice(0, maxChars * 2 - 3) + '...';
  // Split into 2 lines if needed
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

  let svg = '';
  for (let i = 0; i < Math.min(lines.length, 2); i++) {
    svg += `<text x="80" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="500" fill="#7a7a8a">${escapeXml(lines[i])}</text>\n`;
    y += 28;
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

      // Extract description from meta
      const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
      const desc = descMatch ? descMatch[1] : '';

      // Compute the output path — mirror the docs URL structure
      const relPath = path.relative(docsDir, fullPath);
      const slug = relPath.replace(/\.html$/, '').replace(/\//g, '-');
      const pngName = `docs-${slug}.png`;
      const pngPath = path.join(ogOutDir, pngName);

      // Generate title and description SVG fragments
      const { svg: titleSvg, nextY } = titleToSvg(title, 260);
      const descSvg = descToSvg(desc, nextY + 20);

      const svg = template
        .replace('{{LOGO_SVG}}', logoSvg)
        .replace('{{TITLE_SVG}}', titleSvg)
        .replace('{{DESC_SVG}}', descSvg);

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