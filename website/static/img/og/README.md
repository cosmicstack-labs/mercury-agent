# Per-page OG / Social Cards

This directory holds **per-page Open Graph / Twitter card images** for Mercury Agent pages.

## Why a dedicated folder

The site's global default social card lives at `static/img/card.png`. Every page falls back to it automatically (via `themeConfig.image` in `docusaurus.config.ts`).

Some pages — release notes, marquee landing pages, and the homepage — deserve their **own** card so that when a link is shared on Twitter/X, LinkedIn, Slack, or Discord, the preview is contextual instead of the generic site card.

## Convention

For every page that wants a custom card:

1. Drop the image here as `static/img/og/<slug>.png` (1200 × 630 PNG, &lt; 1 MB).
2. Set the page's frontmatter:

   ```yaml
   ---
   title: "v1.1.11 — Skilly Mercury"
   image: /img/og/1.1.11.png
   description: "Mercury becomes a skillful platform. Skill System, Token Saver, standalone binaries…"
   ---
   ```

3. For the React landing pages (`src/pages/*.tsx`), set the meta tags inside the `<Head>` block:

   ```tsx
   <meta property="og:image" content="https://mercuryagent.sh/img/og/home.png" />
   <meta name="twitter:image" content="https://mercuryagent.sh/img/og/home.png" />
   ```

Docusaurus picks up the frontmatter `image:` and emits the right `og:image` and `twitter:image` meta tags automatically for docs pages.

## Slug → file mapping

| Page | Frontmatter / Head | File |
|---|---|---|
| Homepage (`src/pages/index.tsx`) | `<Head>` meta | `home.png` (SVG fallback: `home.svg`) |
| `docs/releases/releases` | `image: /img/card.png` (uses global) | — |
| `docs/releases/1.1.11` | `image: /img/og/1.1.11.png` | `1.1.11.png` (SVG fallback: `1.1.11.svg`) |
| `docs/releases/1.1.9` and earlier | — (uses global) | — |

## SVG vs PNG

PNG is the safest format — every social platform renders it. **SVGs are committed in this folder as templates** (`*.svg`) for two reasons:

1. They're the design source — easy to edit colors / copy / version label without a graphics tool.
2. Some platforms (Twitter/X, Discord) render SVG OG images correctly. Others (LinkedIn, Slack) do not.

**Before each release**, convert the SVG to PNG (any tool works — Inkscape, ImageMagick, Figma export, or `npx svgexport in.svg out.png 1200:630`). Commit the PNG alongside the SVG.

## Redirect targets

Each page that has a dedicated card is also a stable redirect target — share `https://mercuryagent.sh/docs/releases/1.1.11` directly and the rich preview shows the matching card. The HTML emitted by Docusaurus is fully static, so any short link / redirect (e.g. `mercury.sh/v1.1.11`) that lands on the canonical URL will surface the right preview.
