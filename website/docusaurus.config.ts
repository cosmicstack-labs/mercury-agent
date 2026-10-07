import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Mercury Agent',
  tagline: 'The open-source AI agent you can leave running. Remembers what matters, asks before it acts, works with any model.',
  favicon: 'img/logo-light.png',

  future: {
    v4: true,
  },

  url: 'https://mercuryagent.sh',
  baseUrl: '/',
  trailingSlash: false,

  organizationName: 'cosmicstack-labs',
  projectName: 'mercury-agent',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',

  // Default page metadata. Per-page `image:` frontmatter overrides for OG/Twitter cards.
  // See website/static/img/og/README.md for the per-page convention.
  headTags: [
    {
      tagName: 'meta',
      attributes: { name: 'twitter:site', content: '@mercuryagent' },
    },
    {
      tagName: 'meta',
      attributes: { property: 'og:site_name', content: 'Mercury Agent' },
    },
    {
      tagName: 'meta',
      attributes: { name: 'application-name', content: 'Mercury Agent' },
    },
    { tagName: 'link', attributes: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
    { tagName: 'link', attributes: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' } },
    {
      tagName: 'link',
      attributes: {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap',
      },
    },
    { tagName: 'link', attributes: { rel: 'apple-touch-icon', href: '/img/logo-light.png' } },
  ],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  scripts: [
    { src: 'https://analytics.cosmicstack.org/js/pa--flkUFvdfmsPSUtRivKAK.js', async: true },
    { src: '/js/plausible-init.js' },
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        indexBlog: false,
        docsRouteBasePath: '/docs',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/cosmicstack-labs/mercury-agent/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/og/home.png',
    metadata: [
      {
        name: 'keywords',
        content: 'ai agent, open source ai agent, self-hosted ai agent, personal ai agent, cli agent, autonomous agent, telegram ai bot, coding agent, mercury agent',
      },
      { name: 'theme-color', content: '#0a0d10', media: '(prefers-color-scheme: dark)' },
      { name: 'theme-color', content: '#fbfbf8', media: '(prefers-color-scheme: light)' },
    ],
    colorMode: {
      respectPrefersColorScheme: true,
    },
    // Bump with every release, together with RELEASE in src/components/Home/data.ts.
    announcementBar: {
      id: 'release-1-3-0',
      content: '☿ Mercury 1.3.0, <strong>Mercury Bots</strong>, is out: persistent agents that work as a fleet. <a href="/docs/releases/1.3.0">Read the release notes →</a>',
      isCloseable: true,
    },
    navbar: {
      title: 'Mercury',
      hideOnScroll: false,
      logo: {
        alt: 'Mercury Agent',
        src: 'img/logo-light.png',
        srcDark: 'img/logo-dark.png',
      },
      items: [
        {to: '/docs', label: 'Docs', position: 'left'},
        {to: '/docs/integrations/coding-workspace', label: 'Code', position: 'left'},
        {to: '/docs/integrations/mercury-bots', label: 'Bots', position: 'left'},
        {to: '/cloud', label: 'Cloud', position: 'left'},
        {href: 'https://skills.mercuryagent.sh', label: 'Skills', position: 'left'},
        {to: '/docs/releases', label: 'Changelog', position: 'left'},
        {
          href: 'https://github.com/cosmicstack-labs/mercury-agent',
          position: 'right',
          className: 'navbar-github',
          'aria-label': 'Mercury Agent on GitHub',
        },
        {to: '/#install', label: 'Install', position: 'right', className: 'navbar-cta'},
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Product',
          items: [
            {label: 'Install', to: '/#install'},
            {label: 'Mercury Code', to: '/docs/integrations/coding-workspace'},
            {label: 'Mercury Bots', to: '/docs/integrations/mercury-bots'},
            {label: 'Mercury Cloud', to: '/cloud'},
            {label: 'Changelog', to: '/docs/releases'},
          ],
        },
        {
          title: 'Trust',
          items: [
            {label: 'Permissions model', to: '/docs/reference/permissions'},
            {label: 'Second Brain memory', to: '/docs/reference/second-brain'},
            {label: 'Completion contract', to: '/docs/reference/completion-architecture'},
            {label: 'Honest comparison', to: '/#compare'},
          ],
        },
        {
          title: 'Docs',
          items: [
            {label: 'Getting started', to: '/docs'},
            {label: 'CLI commands', to: '/docs/cli-commands/cli-commands'},
            {label: 'Built-in tools', to: '/docs/reference/built-in-tools'},
            {label: 'Configuration', to: '/docs/reference/configuration'},
          ],
        },
        {
          title: 'Community',
          items: [
            {label: 'GitHub', href: 'https://github.com/cosmicstack-labs/mercury-agent'},
            {label: 'Issues', href: 'https://github.com/cosmicstack-labs/mercury-agent/issues'},
            {label: 'Skills registry', href: 'https://skills.mercuryagent.sh'},
            {label: 'npm', href: 'https://www.npmjs.com/package/@cosmicstack/mercury-agent'},
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Cosmic Stack · Mercury Agent is MIT-licensed open source.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
