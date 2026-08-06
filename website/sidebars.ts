import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'getting-started/installation',
    {
      type: 'category',
      label: 'Platforms',
      collapsed: false,
      items: [
        'getting-started/platforms/macos',
        'getting-started/platforms/linux',
        'getting-started/platforms/windows',
        'getting-started/platforms/termux',
      ],
    },
    'getting-started/setup',
    'getting-started/starting',
    'getting-started/build-from-source',
    {
      type: 'category',
      label: 'CLI Commands',
      collapsed: false,
      items: [
        'cli-commands/cli-commands',
        'cli-commands/doctor',
        'cli-commands/skills',
        'cli-commands/in-chat-commands',
      ],
    },
    {
      type: 'category',
      label: 'Daemon Mode',
      collapsed: true,
      items: [
        'daemon-mode/daemon-mode',
        'daemon-mode/system-service',
        'daemon-mode/platform-guide',
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      collapsed: false,
      items: [
        'integrations/web-dashboard',
        'integrations/kanban-boards',
        'integrations/github-companion',
        'integrations/telegram',
        'integrations/discord',
        'integrations/slack',
        'integrations/signal',
        'integrations/spotify',
        'integrations/coding-workspace',
        'integrations/sub-agents',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: true,
      items: [
        'reference/built-in-tools',
        'reference/configuration',
        'reference/permissions',
        'reference/second-brain',
        'reference/provider-fallback',
        'reference/scheduling',
        'reference/skills',
        'reference/token-saver',
      ],
    },
    {
      type: 'category',
      label: 'Releases',
      collapsed: false,
      items: [
        'releases/releases',
        'releases/1.1.13',
        'releases/1.1.12',
        'releases/1.1.11',
        'releases/1.1.9',
        'releases/1.1.7',
        'releases/1.1.6',
      ],
    },
  ],
};

export default sidebars;
