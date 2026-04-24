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
    name, maskedKey, baseUrl, model, enabled,
    key: '', showKey: false, hasKey: !!maskedKey,
    saving: false, testing: false, feedback: '',
    async save() {
      this.saving = true; this.feedback = '';
      try {
        const payload = { enabled: this.enabled, baseUrl: this.baseUrl, model: this.model };
        if (this.key) payload.apiKey = this.key;
        const res = await fetch(`/api/providers/${this.name}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.success) {
          this.feedback = 'Saved!';
          if (this.key) { this.hasKey = true; this.maskedKey = this.key.slice(0,4)+'••••'+this.key.slice(-4); this.key = ''; }
        } else { this.feedback = data.error || 'Failed to save'; }
      } catch (e) { this.feedback = 'Error saving'; }
      this.saving = false;
      setTimeout(() => { this.feedback = ''; }, 3000);
    },
    async testKey() {
      this.testing = true; this.feedback = '';
      try {
        const res = await fetch(`/api/providers/${this.name}/test`, { method: 'POST' });
        const data = await res.json();
        this.feedback = data.success ? `Connected! ${data.models ? data.models.length + ' models' : ''}` : (data.error || 'Connection failed');
      } catch (e) { this.feedback = 'Connection failed'; }
      this.testing = false;
      setTimeout(() => { this.feedback = ''; }, 4000);
    },
  };
}

function settings() {
  return {
    newUsername: '', currentPassword: '', savingUsername: false, usernameFeedback: '',
    currentPasswordPw: '', newPassword: '', confirmPassword: '', savingPassword: false, passwordFeedback: '',
    savingIdentity: false, identityFeedback: '', identity: { name: '', owner: '' },
    defaultProvider: 'deepseek', providerFeedback: '',
    async init() {
      try {
        const res = await fetch('/api/config');
        if (res.ok) { const cfg = await res.json(); this.identity = cfg.identity || {name:'',owner:''}; this.defaultProvider = cfg.defaultProvider || 'deepseek'; }
      } catch (e) { console.error(e); }
    },
    async changeUsername() {
      this.savingUsername = true; this.usernameFeedback = '';
      try {
        const res = await fetch('/api/auth/username', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({currentPassword: this.currentPassword, newUsername: this.newUsername}) });
        const data = await res.json();
        this.usernameFeedback = data.success ? 'Username updated!' : (data.error || 'Failed');
        if (data.success) { this.newUsername = ''; this.currentPassword = ''; }
      } catch (e) { this.usernameFeedback = 'Error'; }
      this.savingUsername = false;
      setTimeout(() => { this.usernameFeedback = ''; }, 3000);
    },
    async changePassword() {
      if (this.newPassword !== this.confirmPassword) { this.passwordFeedback = 'Passwords do not match'; return; }
      this.savingPassword = true; this.passwordFeedback = '';
      try {
        const res = await fetch('/api/auth/password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({currentPassword: this.currentPasswordPw, newPassword: this.newPassword}) });
        const data = await res.json();
        this.passwordFeedback = data.success ? 'Password updated!' : (data.error || 'Failed');
        if (data.success) { this.currentPasswordPw = ''; this.newPassword = ''; this.confirmPassword = ''; }
      } catch (e) { this.passwordFeedback = 'Error'; }
      this.savingPassword = false;
      setTimeout(() => { this.passwordFeedback = ''; }, 3000);
    },
    async saveIdentity() {
      this.savingIdentity = true; this.identityFeedback = '';
      try {
        const res = await fetch('/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({identity: this.identity}) });
        const data = await res.json();
        this.identityFeedback = data.success ? 'Saved!' : 'Failed';
      } catch (e) { this.identityFeedback = 'Error'; }
      this.savingIdentity = false;
      setTimeout(() => { this.identityFeedback = ''; }, 3000);
    },
    async saveDefaultProvider() {
      this.providerFeedback = '';
      try {
        const res = await fetch('/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({defaultProvider: this.defaultProvider}) });
        const data = await res.json();
        this.providerFeedback = data.success ? 'Saved!' : 'Failed';
      } catch (e) { this.providerFeedback = 'Error'; }
      setTimeout(() => { this.providerFeedback = ''; }, 3000);
    },
    setTheme(theme) {
      let effective = theme;
      if (theme === 'system') effective = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', effective);
      if (theme === 'system') localStorage.removeItem('mercury-theme'); else localStorage.setItem('mercury-theme', theme);
    },
  };
}

const TYPE_COLORS = {
  identity: '#00d4ff', preference: '#febc2e', goal: '#28c840', project: '#a855f7',
  habit: '#f97316', decision: '#3b82f6', constraint: '#ef4444', relationship: '#ec4899',
  episode: '#6366f1', reflection: '#14b8a6',
};

const MEMORY_TYPES = {
  identity: 'Identity', preference: 'Preference', goal: 'Goal', project: 'Project',
  habit: 'Habit', decision: 'Decision', constraint: 'Constraint', relationship: 'Relationship',
  episode: 'Episode', reflection: 'Reflection',
};

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function memoryBrowser() {
  return {
    memories: [], loading: true, query: '', selectedMemory: null,
    showAddModal: false, newMemory: { type: 'preference', summary: '', detail: '' },
    memoryTypes: MEMORY_TYPES, typeColors: TYPE_COLORS,
    getTypeColor(type) { return TYPE_COLORS[type] || '#888'; },
    async init() {
      this.loading = true;
      try {
        const res = await fetch('/api/brain/memory?limit=100');
        if (res.ok) { const data = await res.json(); this.memories = data.memories || []; }
      } catch (e) { console.error(e); }
      this.loading = false;
    },
    async search() {
      this.loading = true;
      try {
        const url = this.query ? `/api/brain/memory/search?q=${encodeURIComponent(this.query)}&limit=50` : '/api/brain/memory?limit=100';
        const res = await fetch(url);
        if (res.ok) { const data = await res.json(); this.memories = data.memories || []; }
      } catch (e) { console.error(e); }
      this.loading = false;
    },
    async addMemory() {
      if (!this.newMemory.summary) return;
      try {
        const res = await fetch('/api/brain/memory', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(this.newMemory) });
        if (res.ok || res.status === 201) { this.showAddModal = false; this.newMemory = {type:'preference',summary:'',detail:''}; await this.init(); }
      } catch (e) { console.error(e); }
    },
    selectMemory(mem) { this.selectedMemory = {...mem}; },
    async deleteMemory(id) {
      if (!id) return;
      if (!confirm('Delete this memory?')) return;
      try {
        await fetch(`/api/brain/memory/${id}`, { method: 'DELETE' });
        this.selectedMemory = null;
        await this.init();
      } catch (e) { console.error(e); }
    },
  };
}

function goalsBrowser() {
  return {
    goals: [], loading: true, selectedGoal: null, showAddGoal: false,
    newGoal: { type: 'goal', summary: '', detail: '' },
    formatDate(ts) { return formatDate(ts); },
    async init() {
      this.loading = true;
      try {
        const res = await fetch('/api/brain/memory?type=goal&limit=50');
        const projectRes = await fetch('/api/brain/memory?type=project&limit=50');
        let goals = [];
        if (res.ok) { const data = await res.json(); goals = goals.concat(data.memories || []); }
        if (projectRes.ok) { const data = await projectRes.json(); goals = goals.concat(data.memories || []); }
        this.goals = goals;
      } catch (e) { console.error(e); }
      this.loading = false;
    },
    async addGoal() {
      if (!this.newGoal.summary) return;
      try {
        const res = await fetch('/api/brain/memory', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(this.newGoal) });
        if (res.ok || res.status === 201) { this.showAddGoal = false; this.newGoal = {type:'goal',summary:'',detail:''}; await this.init(); }
      } catch (e) { console.error(e); }
    },
    async deleteGoal(id) {
      if (!id) return;
      if (!confirm('Delete this goal?')) return;
      try { await fetch(`/api/brain/memory/${id}`, { method: 'DELETE' }); this.selectedGoal = null; await this.init(); } catch (e) { console.error(e); }
    },
  };
}

function brainGraph() {
  return {
    nodes: [], edges: [], loading: true, layoutRunning: false,
    activeTypes: Object.keys(TYPE_COLORS), typeColors: TYPE_COLORS,
    searchQuery: '', hoveredNode: null, selectedNode: null,
    tooltipStyle: 'top:0;left:0;display:none;',
    // Canvas state
    canvas: null, ctx: null, pan: {x:0,y:0}, zoom: 1,
    dragging: false, dragNode: null, lastMouse: {x:0,y:0},
    positions: new Map(),

    getTypeColor(type) { return TYPE_COLORS[type] || '#888888'; },
    formatDate(ts) { return formatDate(ts); },

    async init() {
      this.loading = true;
      try {
        const res = await fetch('/api/brain/graph');
        if (res.ok) {
          const data = await res.json();
          this.nodes = data.nodes || [];
          this.edges = data.edges || [];
          this.initPositions();
          this.runLayout();
        }
      } catch (e) { console.error(e); }
      this.loading = false;

      this.canvas = this.$refs.graphCanvas;
      if (this.canvas) {
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
        window.addEventListener('resize', () => { this.resizeCanvas(); this.draw(); });
        this.draw();
      }
    },

    resizeCanvas() {
      if (!this.canvas) return;
      const container = this.$refs.graphContainer;
      if (!container) return;
      this.canvas.width = container.clientWidth;
      this.canvas.height = container.clientHeight;
    },

    initPositions() {
      const cx = 400, cy = 300;
      this.positions.clear();
      this.nodes.forEach((node, i) => {
        const angle = (i / this.nodes.length) * Math.PI * 2;
        const r = 150 + Math.random() * 100;
        this.positions.set(node.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
      });
    },

    runLayout() {
      this.layoutRunning = true;
      const iters = 80;
      for (let iter = 0; iter < iters; iter++) {
        const k = Math.sqrt((this.canvas ? this.canvas.width : 800) * (this.canvas ? this.canvas.height : 600) / Math.max(1, this.nodes.length));
        const repForce = k * k;
        const attForce = 0.01;
        const forces = new Map();
        this.nodes.forEach(n => forces.set(n.id, {fx:0, fy:0}));

        // Repulsion
        for (let i = 0; i < this.nodes.length; i++) {
          for (let j = i+1; j < this.nodes.length; j++) {
            const pi = this.positions.get(this.nodes[i].id);
            const pj = this.positions.get(this.nodes[j].id);
            if (!pi || !pj) continue;
            let dx = pi.x - pj.x, dy = pi.y - pj.y;
            const dist = Math.max(Math.sqrt(dx*dx+dy*dy), 1);
            const f = repForce / (dist * dist);
            forces.get(this.nodes[i].id).fx += (dx/dist)*f;
            forces.get(this.nodes[i].id).fy += (dy/dist)*f;
            forces.get(this.nodes[j].id).fx -= (dx/dist)*f;
            forces.get(this.nodes[j].id).fy -= (dy/dist)*f;
          }
        }
        // Attraction
        this.edges.forEach(e => {
          const ps = this.positions.get(e.source), pt = this.positions.get(e.target);
          if (!ps || !pt) return;
          let dx = pt.x - ps.x, dy = pt.y - ps.y;
          const dist = Math.sqrt(dx*dx+dy*dy);
          forces.get(e.source).fx += dx * attForce;
          forces.get(e.source).fy += dy * attForce;
          forces.get(e.target).fx -= dx * attForce;
          forces.get(e.target).fy -= dy * attForce;
        });
        // Apply
        const damp = 0.1;
        this.nodes.forEach(n => {
          const f = forces.get(n.id);
          const p = this.positions.get(n.id);
          if (!f || !p) return;
          p.x += f.fx * damp;
          p.y += f.fy * damp;
        });
      }
      this.layoutRunning = false;
      this.draw();
    },

    draw() {
      if (!this.ctx || !this.canvas) return;
      const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(this.pan.x, this.pan.y);
      ctx.scale(this.zoom, this.zoom);

      // Edges
      ctx.strokeStyle = 'var(--cyan-glow)' in ctx ? 'rgba(0,212,255,0.15)' : 'rgba(0,212,255,0.15)';
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      ctx.strokeStyle = isDark ? 'rgba(0,212,255,0.12)' : 'rgba(0,136,170,0.12)';
      ctx.lineWidth = 1 / this.zoom;
      this.edges.forEach(e => {
        const ps = this.positions.get(e.source), pt = this.positions.get(e.target);
        if (!ps || !pt) return;
        ctx.beginPath(); ctx.moveTo(ps.x, ps.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
      });

      // Nodes
      const searchQ = this.searchQuery.toLowerCase();
      this.nodes.forEach(n => {
        const p = this.positions.get(n.id);
        if (!p) return;
        const isHovered = this.hoveredNode && this.hoveredNode.id === n.id;
        const isSelected = this.selectedNode && this.selectedNode.id === n.id;
        const isSearchMatch = searchQ && n.fullLabel.toLowerCase().includes(searchQ);
        const r = (n.size || 6) * (isHovered || isSelected ? 1.5 : 1);

        if (searchQ && !isSearchMatch) {
          ctx.globalAlpha = 0.2;
        } else {
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.color || '#888888';
        ctx.fill();

        if (isHovered || isSelected || isSearchMatch) {
          ctx.strokeStyle = isDark ? '#f0f0f0' : '#1a1a1a';
          ctx.lineWidth = 2 / this.zoom;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });

      ctx.restore();
    },

    screenToGraph(sx, sy) {
      return { x: (sx - this.pan.x) / this.zoom, y: (sy - this.pan.y) / this.zoom };
    },

    findNodeAt(gx, gy) {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const p = this.positions.get(n.id);
        if (!p) continue;
        const r = (n.size || 6) * 1.5;
        const dx = gx - p.x, dy = gy - p.y;
        if (dx*dx + dy*dy < r*r) return n;
      }
      return null;
    },

    onMouseDown(e) {
      const rect = this.canvas.getBoundingClientRect();
      const gp = this.screenToGraph(e.clientX - rect.left, e.clientY - rect.top);
      const node = this.findNodeAt(gp.x, gp.y);
      if (node) { this.dragNode = node; } else { this.dragging = true; }
      this.lastMouse = { x: e.clientX, y: e.clientY };
    },
    onMouseMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const gp = this.screenToGraph(e.clientX - rect.left, e.clientY - rect.top);
      if (this.dragNode) {
        const p = this.positions.get(this.dragNode.id);
        if (p) { p.x = gp.x; p.y = gp.y; this.draw(); }
      } else if (this.dragging) {
        this.pan.x += e.clientX - this.lastMouse.x;
        this.pan.y += e.clientY - this.lastMouse.y;
        this.draw();
      } else {
        const node = this.findNodeAt(gp.x, gp.y);
        if (node !== this.hoveredNode) {
          this.hoveredNode = node;
          const sr = rect.width > 0 ? e.clientX - rect.left + 10 : 0;
          const st = rect.height > 0 ? e.clientY - rect.top + 10 : 0;
          this.tooltipStyle = `top:${st}px;left:${sr}px;`;
          this.draw();
        }
      }
      this.lastMouse = { x: e.clientX, y: e.clientY };
    },
    onMouseUp() { this.dragNode = null; this.dragging = false; },
    onWheel(e) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      this.pan.x = mx - (mx - this.pan.x) * delta;
      this.pan.y = my - (my - this.pan.y) * delta;
      this.zoom *= delta;
      this.draw();
    },
    onDblClick(e) {
      const rect = this.canvas.getBoundingClientRect();
      const gp = this.screenToGraph(e.clientX - rect.left, e.clientY - rect.top);
      const node = this.findNodeAt(gp.x, gp.y);
      this.selectedNode = node || null;
    },
    rebuildGraph() {
      this.init();
    },
    highlightSearch() {
      this.draw();
    },
  };
}