import { Context } from 'hono';
import { getCookie } from 'hono/cookie';

const NAV_ITEMS = [
  { href: '/', label: 'Status', icon: '⬡' },
  { href: '/chat', label: 'Chat', icon: '💬' },
  { separator: true },
  { heading: 'Second Brain' },
  { href: '/second-brain/memory', label: 'Memory', icon: '💭' },
  { href: '/second-brain/persons', label: 'Persons', icon: '🧑' },
  { href: '/second-brain/goals', label: 'Goals', icon: '🎯' },
  { href: '/second-brain/graph', label: 'Graph', icon: '🧠' },
  { separator: true },
  { href: '/providers', label: 'Keys', icon: '🔑' },
  { href: '/skills', label: 'Skills', icon: '🧩' },
  { href: '/permissions', label: 'Perms', icon: '🔒' },
  { href: '/team', label: 'Team', icon: '👥' },
  { href: '/usage', label: 'Usage', icon: '📊' },
  { separator: true },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function renderLayout(c: Context, title: string, body: string): string {
  const activePath = new URL(c.req.url).pathname;
  const navHtml = NAV_ITEMS.map(item => {
    if ('separator' in item) {
      return '<div class="nav-sep"></div>';
    }
    if ('heading' in item) {
      return `<div class="nav-heading">${item.heading}</div>`;
    }
    const active = item.href === activePath || (item.href !== '/' && activePath.startsWith(item.href));
    const cls = active ? 'nav-item active' : 'nav-item';
    return `<a href="${item.href}" class="${cls}"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span></a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en" data-theme="">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Mercury</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/vendor/htmx.min.js"></script>
  <script defer src="/vendor/alpine.min.js"></script>
  <script>
    (function() {
      var t = localStorage.getItem('mercury-theme');
      if (!t) { t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
</head>
<body>
  <div class="app" x-data="{ sidebarOpen: window.innerWidth > 768 }" :class="{ 'sidebar-closed': !sidebarOpen }">
    <aside class="sidebar">
      <div class="sidebar-head">
        <a href="/" class="logo">☿ Mercury</a>
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
          <span x-text="dark ? '☀' : '🌙'"></span>
        </button>
        <a href="/api/auth/logout" class="nav-item logout-btn">
          <span class="nav-icon">⏻</span><span class="nav-label">Logout</span>
        </a>
      </div>
    </aside>
    <button class="sidebar-toggle" @click="sidebarOpen = !sidebarOpen">
      <span x-text="sidebarOpen ? '←' : '→'"></span>
    </button>
    <main class="main">
      ${body}
    </main>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`;
}
