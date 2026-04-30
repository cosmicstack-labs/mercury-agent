import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/__docusaurus/debug',
    component: ComponentCreator('/__docusaurus/debug', '5ff'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/config',
    component: ComponentCreator('/__docusaurus/debug/config', '5ba'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/content',
    component: ComponentCreator('/__docusaurus/debug/content', 'a2b'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/globalData',
    component: ComponentCreator('/__docusaurus/debug/globalData', 'c3c'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/metadata',
    component: ComponentCreator('/__docusaurus/debug/metadata', '156'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/registry',
    component: ComponentCreator('/__docusaurus/debug/registry', '88c'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/routes',
    component: ComponentCreator('/__docusaurus/debug/routes', '000'),
    exact: true
  },
  {
    path: '/search',
    component: ComponentCreator('/search', '822'),
    exact: true
  },
  {
    path: '/docs',
    component: ComponentCreator('/docs', 'b4b'),
    routes: [
      {
        path: '/docs',
        component: ComponentCreator('/docs', '275'),
        routes: [
          {
            path: '/docs',
            component: ComponentCreator('/docs', '5af'),
            routes: [
              {
                path: '/docs',
                component: ComponentCreator('/docs', '731'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/cli-commands/cli-commands',
                component: ComponentCreator('/docs/cli-commands/cli-commands', '5e0'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/cli-commands/doctor',
                component: ComponentCreator('/docs/cli-commands/doctor', '165'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/cli-commands/in-chat-commands',
                component: ComponentCreator('/docs/cli-commands/in-chat-commands', '3be'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/daemon-mode/daemon-mode',
                component: ComponentCreator('/docs/daemon-mode/daemon-mode', '9c7'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/daemon-mode/platform-guide',
                component: ComponentCreator('/docs/daemon-mode/platform-guide', '346'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/daemon-mode/system-service',
                component: ComponentCreator('/docs/daemon-mode/system-service', 'd3a'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/getting-started/setup',
                component: ComponentCreator('/docs/getting-started/setup', '870'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/getting-started/starting',
                component: ComponentCreator('/docs/getting-started/starting', '449'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/integrations/github-companion',
                component: ComponentCreator('/docs/integrations/github-companion', 'b37'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/integrations/telegram',
                component: ComponentCreator('/docs/integrations/telegram', 'ebc'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/built-in-tools',
                component: ComponentCreator('/docs/reference/built-in-tools', 'e86'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/configuration',
                component: ComponentCreator('/docs/reference/configuration', '171'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/permissions',
                component: ComponentCreator('/docs/reference/permissions', 'bd4'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/provider-fallback',
                component: ComponentCreator('/docs/reference/provider-fallback', 'b47'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/scheduling',
                component: ComponentCreator('/docs/reference/scheduling', '0b4'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/second-brain',
                component: ComponentCreator('/docs/reference/second-brain', '2c4'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/skills',
                component: ComponentCreator('/docs/reference/skills', 'd27'),
                exact: true,
                sidebar: "docsSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
