import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'getting-started/installation',
    'getting-started/setup',
    'getting-started/starting',
    {
      type: 'category',
      label: 'CLI Commands',
      collapsed: false,
      items: [
        'cli-commands/cli-commands',
        'cli-commands/doctor',
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
        'integrations/github-companion',
        'integrations/telegram',
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
      ],
    },
    {
      type: 'category',
      label: 'Releases',
      collapsed: true,
      items: [
        'releases/releases',
        'releases/1.1.7',
        'releases/1.1.6',
      ],
    },
  ],
};

export default sidebars;
