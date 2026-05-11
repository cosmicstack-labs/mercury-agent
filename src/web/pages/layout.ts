import { Context } from 'hono';
import { getCookie } from 'hono/cookie';

const NAV_ITEMS = [
  { href: '/', label: 'Status', icon: 'activity' },
  { href: '/chat', label: 'Chat', icon: 'message-circle' },
  { href: '/tasks', label: 'Tasks', icon: 'layers' },
  { separator: true },
  { heading: 'Second Brain' },
  { href: '/second-brain/memory', label: 'Memory', icon: 'brain' },
  { href: '/second-brain/persons', label: 'Persons', icon: 'users' },
  { href: '/second-brain/goals', label: 'Goals', icon: 'target' },
  { href: '/second-brain/graph', label: 'Graph', icon: 'network' },
  { separator: true },
  { href: '/providers', label: 'Keys', icon: 'key' },
  { href: '/skills', label: 'Skills', icon: 'puzzle' },
  { href: '/permissions', label: 'Perms', icon: 'shield' },
  { href: '/schedules', label: 'Schedules', icon: 'clock' },
  { href: '/usage', label: 'Usage', icon: 'bar-chart-3' },
  { separator: true },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

function svgIcon(name: string): string {
  return `<svg><use href="/vendor/icons.svg#${name}"/></svg>`;
}

export function renderLayout(c: Context, title: string, body: string): string {
  const activePath = new URL(c.req.url).pathname;
  const isChat = activePath === '/chat';
  const bodyClass = isChat ? 'chat-page' : '';
  const navHtml = NAV_ITEMS.map(item => {
    if ('separator' in item) {
      return '<div class="nav-sep"></div>';
    }
    if ('heading' in item) {
      return `<div class="nav-heading">${item.heading}</div>`;
    }
    const active = item.href === activePath || (item.href !== '/' && activePath.startsWith(item.href));
    const cls = active ? 'nav-item active' : 'nav-item';
    return `<a href="${item.href}" class="${cls}"><span class="nav-icon">${svgIcon(item.icon)}</span><span class="nav-label">${item.label}</span></a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en" data-theme="">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Mercury</title>
  <link rel="stylesheet" href="/static/style.css">
  <script defer src="/vendor/alpine.min.js"></script>
  <script>
    (function() {
      var t = localStorage.getItem('mercury-theme');
      if (!t) { t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
</head>
<body class="${bodyClass}">
  <div class="app" x-data="{ sidebarOpen: window.innerWidth > 768 }" :class="{ 'sidebar-closed': !sidebarOpen }">
    <aside class="sidebar">
      <div class="sidebar-head">
        <a href="/" class="logo"><span class="logo-mark">☿</span><span>Mercury</span></a>
      </div>
      <nav class="sidebar-nav">${navHtml}</nav>
      <div class="sidebar-foot">
        <button class="theme-toggle" @click="toggleTheme()" x-data="{
          dark: document.documentElement.getAttribute('data-theme') !== 'light',
          toggleTheme() {
            this.dark = !this.dark;
            var v = this.dark ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', v);
            localStorage.setItem('mercury-theme', v);
          }
        }">
          <span x-show="dark">${svgIcon('sun')}</span>
          <span x-show="!dark">${svgIcon('moon')}</span>
        </button>
        <a href="/api/auth/logout" class="nav-item logout-btn">
          <span class="nav-icon">${svgIcon('log-out')}</span><span class="nav-label">Logout</span>
        </a>
      </div>
    </aside>
    <button class="sidebar-toggle" @click="sidebarOpen = !sidebarOpen">
      <span x-show="sidebarOpen">${svgIcon('panel-left-close')}</span>
      <span x-show="!sidebarOpen">${svgIcon('panel-left-open')}</span>
    </button>
    <main class="main">
      ${body}
    </main>
  </div>
  <script src="/static/app.js"><\/script>
</body>
</html>`;
}