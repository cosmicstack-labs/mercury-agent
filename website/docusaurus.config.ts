import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Mercury Agent — Soul-driven',
  tagline: 'Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access. Runs 24/7 from CLI, Web, Telegram, Discord, Slack, or Signal.',
  favicon: 'img/favicon.svg',

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
      attributes: { property: 'og:site_name', content: 'Mercury Agent — Soul-driven' },
    },
    {
      tagName: 'meta',
      attributes: { name: 'application-name', content: 'Mercury Agent' },
    },
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
    image: 'img/card.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: '☿ Mercury Agent',
      logo: {
        alt: 'Mercury Agent — Soul-driven',
        src: 'img/logo-light.png',
        srcDark: 'img/logo-dark.png',
      },
      items: [
        {to: '/docs', label: 'Docs', position: 'left'},
        {to: '/cloud', label: 'Mercury Cloud', position: 'left'},
        {to: '/docs/releases/1.2.0', label: 'Releases', position: 'left'},
        {
          href: 'https://github.com/cosmicstack-labs/mercury-agent',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Getting Started', to: '/docs'},
            {label: 'Mercury Cloud', to: '/cloud'},
          ],
        },
        {
          title: 'More',
          items: [
            {label: 'GitHub', href: 'https://github.com/cosmicstack-labs/mercury-agent'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Cosmic Stack. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
