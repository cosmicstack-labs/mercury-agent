/**
 * LLM-ready output for mercuryagent.sh, written after every build:
 *
 *   /llms.txt         an index in the llmstxt.org format: what Mercury is,
 *                     where the docs are, and every blog post with a
 *                     one-line summary and a link to its Markdown copy
 *   /llms-full.txt    the full text of every blog post, concatenated
 *   /blog/<slug>.md   each post as clean Markdown (front matter reduced to
 *                     title/date/authors/tags/canonical URL, MDX stripped),
 *                     linked from the article page and its <head>
 *
 * Posts are read from website/blog/<folder>/index.md(x). The slug comes
 * from the post's `slug` front matter, or the folder name minus the date.
 */
const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const yaml = require('js-yaml');

const SITE = 'https://mercuryagent.sh';

function readPosts(blogDir) {
  if (!fs.existsSync(blogDir)) return [];
  const authors = fs.existsSync(path.join(blogDir, 'authors.yml'))
    ? yaml.load(fs.readFileSync(path.join(blogDir, 'authors.yml'), 'utf8')) ?? {}
    : {};
  const posts = [];
  for (const entry of fs.readdirSync(blogDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(blogDir, entry.name);
    const file = ['index.mdx', 'index.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!file) continue;
    const { data, content } = matter(fs.readFileSync(file, 'utf8'));
    if (data.draft === true || data.unlisted === true) continue;
    const dated = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    const slug = String(data.slug ?? (dated ? dated[2] : entry.name)).replace(/^\/+/, '');
    const date = data.date ? new Date(data.date).toISOString().slice(0, 10) : dated?.[1] ?? '';
    const names = [].concat(data.authors ?? []).map((k) => (typeof k === 'string' ? authors[k]?.name ?? k : k.name));
    posts.push({
      slug,
      title: String(data.title ?? slug),
      description: String(data.description ?? ''),
      date,
      authors: names,
      tags: [].concat(data.tags ?? []).map(String),
      url: `${SITE}/blog/${slug}`,
      body: toPlainMarkdown(content),
    });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

/** Drop MDX-only syntax so the copy reads as ordinary Markdown. */
function toPlainMarkdown(src) {
  return src
    .replace(/^\s*import\s.+?;?\s*$/gm, '')
    .replace(/^\s*export\s.+?;?\s*$/gm, '')
    .replace(/<!--\s*truncate\s*-->/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*<\/?Compare\b[^>]*>\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function postMarkdown(p) {
  return [
    `# ${p.title}`,
    '',
    p.description ? `> ${p.description}` : null,
    p.description ? '' : null,
    `Published ${p.date}${p.authors.length ? ` by ${p.authors.join(', ')}` : ''}. Tags: ${p.tags.join(', ') || 'none'}.`,
    `Canonical: ${p.url}`,
    '',
    p.body,
    '',
  ].filter((l) => l !== null).join('\n');
}

module.exports = function llmsTxtPlugin(context) {
  return {
    name: 'mercury-llms-txt',
    async postBuild({ outDir }) {
      const posts = readPosts(path.join(context.siteDir, 'blog'));
      const blogOut = path.join(outDir, 'blog');
      fs.mkdirSync(blogOut, { recursive: true });
      for (const p of posts) fs.writeFileSync(path.join(blogOut, `${p.slug}.md`), postMarkdown(p));

      const index = [
        '# Mercury Agent',
        '',
        '> Mercury is an open-source, soul-driven AI agent that runs on your own machine. It reaches you from the terminal, Telegram, Discord, Slack, Signal and a local web dashboard, keeps a local long-term memory, asks before it acts through a permission system, stays inside a daily token budget, and keeps running as a background service. It ships Mercury Code (a coding environment) and Mercury Bots (persistent specialist agents).',
        '',
        `Desktop app: Mercury Desktop for macOS (Apple Silicon and Intel), Windows and Linux at ${SITE}/download. It installs Mercury on the computer or connects to one elsewhere, and keeps both updated.`,
        '',
        `Install: \`curl -fsSL ${SITE}/install.sh | sh\` (macOS/Linux), \`irm ${SITE}/install.ps1 | iex\` (Windows), or \`npm i -g @cosmicstack/mercury-agent\` on Node.js 22+. Source: https://github.com/cosmicstack-labs/mercury-agent (MIT).`,
        '',
        '## Docs',
        '',
        `- [Getting started](${SITE}/docs): install, first run, channels`,
        `- [Mercury Desktop](${SITE}/docs/desktop/mercury-desktop): install the app, first run, connecting to a remote Mercury`,
        `- [Updating Mercury](${SITE}/docs/desktop/updating): desktop and server updates, rollback, required updates`,
        `- [Remote access & security](${SITE}/docs/desktop/remote-access): owner approvals, device tokens, /server`,
        `- [CLI commands](${SITE}/docs/cli-commands/cli-commands): every \`mercury\` command`,
        `- [Permissions model](${SITE}/docs/reference/permissions): scopes, approvals, blocklist`,
        `- [Second Brain memory](${SITE}/docs/reference/second-brain): how memory is extracted and recalled`,
        `- [Mercury Code](${SITE}/docs/integrations/coding-workspace): the coding environment`,
        `- [Mercury Bots](${SITE}/docs/integrations/mercury-bots): persistent bots and fleets`,
        `- [Release notes](${SITE}/docs/releases)`,
        '',
        '## Blog',
        '',
        ...posts.map((p) => `- [${p.title}](${SITE}/blog/${p.slug}.md) (${p.date}): ${p.description}`),
        '',
        '## Optional',
        '',
        `- [All blog posts, full text](${SITE}/llms-full.txt)`,
        `- [RSS feed](${SITE}/blog/rss.xml)`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(outDir, 'llms.txt'), index);
      fs.writeFileSync(path.join(outDir, 'llms-full.txt'), posts.map(postMarkdown).join('\n\n---\n\n'));
    },
  };
};

module.exports.readPosts = readPosts;
