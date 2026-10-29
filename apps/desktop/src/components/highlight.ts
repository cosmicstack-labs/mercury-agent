/* ═══════════════════════════════════════════════════════════════
   Syntax highlighting with Shiki, loaded lazily: the highlighter, its
   JavaScript regex engine (no WASM) and each language arrive only when a
   code block needs them. Colours come from two themes at once (light and
   dark) as CSS variables, so a theme switch needs no re-highlight.
   ═══════════════════════════════════════════════════════════════ */

import type { HighlighterCore } from "shiki/core";

const ALIASES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  py: "python", python3: "python", rb: "ruby", rs: "rust", go: "go", golang: "go",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellscript: "bash", ps1: "powershell", pwsh: "powershell",
  yml: "yaml", md: "markdown", html: "html", xml: "xml", svg: "xml", css: "css", scss: "scss",
  json: "json", jsonc: "jsonc", json5: "json5", toml: "toml", ini: "ini", env: "dotenv", dotenv: "dotenv",
  c: "c", h: "c", cpp: "cpp", "c++": "cpp", hpp: "cpp", cs: "csharp", csharp: "csharp", java: "java", kt: "kotlin", kotlin: "kotlin",
  swift: "swift", php: "php", sql: "sql", graphql: "graphql", gql: "graphql", dockerfile: "docker", docker: "docker",
  lua: "lua", r: "r", dart: "dart", scala: "scala", elixir: "elixir", ex: "elixir", hs: "haskell", haskell: "haskell",
  diff: "diff", patch: "diff", make: "makefile", makefile: "makefile", vue: "vue", svelte: "svelte", astro: "astro",
  zig: "zig", nix: "nix", proto: "proto", protobuf: "proto", hcl: "hcl", tf: "terraform", terraform: "terraform",
};

export function languageOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return ALIASES[key] ?? (/^[a-z0-9+#-]{1,20}$/.test(key) ? key : null);
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
const failed = new Set<string>();

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighter) {
    highlighter = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light-default.mjs"),
        import("shiki/themes/github-dark-default.mjs"),
      ]);
      return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
    })();
  }
  return highlighter;
}

async function ensureLanguage(h: HighlighterCore, lang: string): Promise<boolean> {
  if (loaded.has(lang)) return true;
  if (failed.has(lang)) return false;
  try {
    const { bundledLanguages } = await import("shiki/langs");
    const loader = (bundledLanguages as Record<string, () => Promise<{ default: unknown }>>)[lang];
    if (!loader) { failed.add(lang); return false; }
    await h.loadLanguage((await loader()).default as Parameters<HighlighterCore["loadLanguage"]>[0]);
    loaded.add(lang);
    return true;
  } catch {
    failed.add(lang);
    return false;
  }
}

const cache = new Map<string, string>();

/** HTML for a code block, or null when the language is unknown (render plain). */
export async function highlight(code: string, lang: string | null): Promise<string | null> {
  if (!lang) return null;
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = await getHighlighter();
  if (!(await ensureLanguage(h, lang))) return null;
  const html = h.codeToHtml(code, {
    lang,
    themes: { light: "github-light-default", dark: "github-dark-default" },
    defaultColor: false,
  });
  if (cache.size > 300) cache.clear();
  cache.set(key, html);
  return html;
}
