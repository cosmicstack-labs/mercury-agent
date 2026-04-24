function dashboard() {
  return {
    status: {
      running: false,
      state: '—',
      uptime: '—',
      defaultProvider: '—',
      providers: [],
      tokensUsed: 0,
      tokenBudget: 0,
      memoryTotal: 0,
      memoryByType: {},
    },
    async init() {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          this.status = await res.json();
        }
      } catch (e) {
        console.error('Failed to load status:', e);
      }
    },
  };
}

function providerCard(name, maskedKey, baseUrl, model, enabled) {
  return {
    name,
    maskedKey,
    baseUrl,
    model,
    enabled,
    key: '',
    showKey: false,
    hasKey: !!maskedKey,
    saving: false,
    testing: false,
    feedback: '',
    async save() {
      this.saving = true;
      this.feedback = '';
      try {
        const payload = { enabled: this.enabled, baseUrl: this.baseUrl, model: this.model };
        if (this.key) payload.apiKey = this.key;
        const res = await fetch(`/api/providers/${this.name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.success) {
          this.feedback = 'Saved!';
          if (this.key) { this.hasKey = true; this.maskedKey = this.key.slice(0, 4) + '••••' + this.key.slice(-4); this.key = ''; }
        } else {
          this.feedback = data.error || 'Failed to save';
        }
      } catch (e) {
        this.feedback = 'Error saving';
      }
      this.saving = false;
      setTimeout(() => { this.feedback = ''; }, 3000);
    },
    async testKey() {
      this.testing = true;
      this.feedback = '';
      try {
        const res = await fetch(`/api/providers/${this.name}/test`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          this.feedback = `Connected! ${data.models ? data.models.length + ' models found' : ''}`;
        } else {
          this.feedback = data.error || 'Connection failed';
        }
      } catch (e) {
        this.feedback = 'Connection failed';
      }
      this.testing = false;
      setTimeout(() => { this.feedback = ''; }, 4000);
    },
  };
}

function settings() {
  return {
    newUsername: '',
    currentPassword: '',
    savingUsername: false,
    usernameFeedback: '',
    currentPasswordPw: '',
    newPassword: '',
    confirmPassword: '',
    savingPassword: false,
    passwordFeedback: '',
    savingIdentity: false,
    identityFeedback: '',
    identity: { name: '', owner: '' },
    defaultProvider: 'deepseek',
    providerFeedback: '',

    async init() {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const cfg = await res.json();
          this.identity = cfg.identity || { name: '', owner: '' };
          this.defaultProvider = cfg.defaultProvider || 'deepseek';
        }
      } catch (e) { console.error(e); }
    },

    async changeUsername() {
      this.savingUsername = true;
      this.usernameFeedback = '';
      try {
        const res = await fetch('/api/auth/username', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: this.currentPassword, newUsername: this.newUsername }),
        });
        const data = await res.json();
        this.usernameFeedback = data.success ? 'Username updated!' : (data.error || 'Failed');
        if (data.success) { this.newUsername = ''; this.currentPassword = ''; }
      } catch (e) { this.usernameFeedback = 'Error'; }
      this.savingUsername = false;
      setTimeout(() => { this.usernameFeedback = ''; }, 3000);
    },

    async changePassword() {
      if (this.newPassword !== this.confirmPassword) {
        this.passwordFeedback = 'Passwords do not match';
        return;
      }
      this.savingPassword = true;
      this.passwordFeedback = '';
      try {
        const res = await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: this.currentPasswordPw, newPassword: this.newPassword }),
        });
        const data = await res.json();
        this.passwordFeedback = data.success ? 'Password updated!' : (data.error || 'Failed');
        if (data.success) { this.currentPasswordPw = ''; this.newPassword = ''; this.confirmPassword = ''; }
      } catch (e) { this.passwordFeedback = 'Error'; }
      this.savingPassword = false;
      setTimeout(() => { this.passwordFeedback = ''; }, 3000);
    },

    async saveIdentity() {
      this.savingIdentity = true;
      this.identityFeedback = '';
      try {
        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: this.identity }),
        });
        const data = await res.json();
        this.identityFeedback = data.success ? 'Saved!' : 'Failed';
      } catch (e) { this.identityFeedback = 'Error'; }
      this.savingIdentity = false;
      setTimeout(() => { this.identityFeedback = ''; }, 3000);
    },

    async saveDefaultProvider() {
      this.providerFeedback = '';
      try {
        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultProvider: this.defaultProvider }),
        });
        const data = await res.json();
        this.providerFeedback = data.success ? 'Saved!' : 'Failed';
      } catch (e) { this.providerFeedback = 'Error'; }
      setTimeout(() => { this.providerFeedback = ''; }, 3000);
    },

    setTheme(theme) {
      let effective = theme;
      if (theme === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.documentElement.setAttribute('data-theme', effective);
      if (theme === 'system') {
        localStorage.removeItem('mercury-theme');
      } else {
        localStorage.setItem('mercury-theme', theme);
      }
    },
  };
}