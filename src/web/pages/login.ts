export function renderLoginPage(error?: string): string {
  const errorHtml = error ? `<div class="form-error">${error}</div>` : '';
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
  </script>
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo">☿</div>
    <h1 class="login-title">Mercury</h1>
    <p class="login-subtitle">Sign in to your dashboard</p>
    <p class="login-hint">Default: mercury / Mercury@123</p>
    ${errorHtml}
    <form method="POST" action="/api/auth/login" class="login-form"
          x-data="{ username: '', password: '', loading: false }"
          @submit.prevent="loading = true; $nextTick(() => $el.submit())">
      <label class="form-label">
        <span>Username</span>
        <input type="text" name="username" x-model="username" autocomplete="username" required autofocus
               class="form-input">
      </label>
      <label class="form-label">
        <span>Password</span>
        <input type="password" name="password" x-model="password" autocomplete="current-password" required
               class="form-input">
      </label>
      <button type="submit" class="btn btn-primary btn-block" :disabled="loading">
        <span x-text="loading ? 'Signing in...' : 'Sign in'"></span>
      </button>
    </form>
  </div>
  <script src="/vendor/alpine.min.js" defer></script>
</body>
</html>`;
}