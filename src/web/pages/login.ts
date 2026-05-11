export function renderLoginPage(error?: string): string {
  const errorHtml = error ? `<div class="login-error">${error}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en" data-theme="">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Mercury</title>
  <link rel="stylesheet" href="/static/style.css">
  <script>
    (function() {
      var t = localStorage.getItem('mercury-theme');
      if (!t) { t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
      document.documentElement.setAttribute('data-theme', t);
    })();
  <\/script>
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">
        <span class="logo-mark">☿</span>
        <span>Mercury</span>
      </div>
      <p style="color: var(--text-secondary); font-size: 0.8125rem; margin-bottom: 20px;">Sign in to your dashboard</p>
      ${errorHtml}
      <form method="POST" action="/api/auth/login"
            x-data="{ username: '', password: '', loading: false }"
            @submit.prevent="loading = true; $nextTick(() => $el.submit())">
        <div class="form-group">
          <label class="form-label">Username</label>
          <input type="text" name="username" x-model="username" autocomplete="username" required autofocus
                 class="form-input">
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" name="password" x-model="password" autocomplete="current-password" required
                 class="form-input">
        </div>
        <button type="submit" class="btn btn-primary btn-block" :disabled="loading" style="margin-top: 8px;">
          <span x-text="loading ? 'Signing in...' : 'Sign in'"></span>
        </button>
      </form>
      <p style="color: var(--text-faint); font-size: 0.6875rem; margin-top: 16px;">Default: mercury / Mercury@123</p>
    </div>
  </div>
  <script src="/vendor/alpine.min.js" defer><\/script>
</body>
</html>`;
}
