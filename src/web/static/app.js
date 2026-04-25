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
    memoryTypes: MEMORY_TYPES, typeColors: TYPE_COLORS, available: true,
    getTypeColor(type) { return TYPE_COLORS[type] || '#888'; },
    async init() {
      this.loading = true;
      try {
        const statsRes = await fetch('/api/brain/status');
        if (statsRes.ok) {
          const stats = await statsRes.json();
          this.available = stats.available !== false;
          if (!this.available) {
            this.memories = [];
            this.loading = false;
            return;
          }
        }
        const res = await fetch('/api/brain/memory?limit=100');
        if (res.ok) { const data = await res.json(); this.memories = data.memories || []; this.available = data.available !== false; }
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

function personsBrowser() {
  return {
    persons: [],
    loading: true,
    query: '',
    available: true,

    async init() {
      this.loading = true;
      try {
        const statsRes = await fetch('/api/brain/status');
        if (statsRes.ok) {
          const stats = await statsRes.json();
          this.available = stats.available !== false;
          if (!this.available) {
            this.persons = [];
            this.loading = false;
            return;
          }
        }
        const res = await fetch('/api/brain/persons?limit=120');
        if (res.ok) {
          const data = await res.json();
          this.persons = data.persons || [];
          this.available = data.available !== false;
        }
      } catch (e) {
        console.error('Failed to load persons:', e);
      }
      this.loading = false;
    },

    async search() {
      this.loading = true;
      try {
        const url = this.query
          ? `/api/brain/persons?q=${encodeURIComponent(this.query)}&limit=120`
          : '/api/brain/persons?limit=120';
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          this.persons = data.persons || [];
        }
      } catch (e) {
        console.error('Failed to search persons:', e);
      }
      this.loading = false;
    },
  };
}

function personDetail(personId) {
  return {
    personId,
    person: null,
    memories: [],
    loading: true,
    getTypeColor(type) { return TYPE_COLORS[type] || '#888'; },
    formatDate(ts) { return formatDate(ts); },

    async init() {
      this.loading = true;
      try {
        const [personRes, memoriesRes] = await Promise.all([
          fetch(`/api/brain/persons/${this.personId}`),
          fetch(`/api/brain/persons/${this.personId}/memories?limit=100`),
        ]);

        if (personRes.ok) {
          const personData = await personRes.json();
          this.person = personData.person || null;
        } else {
          this.person = null;
        }

        if (memoriesRes.ok) {
          const memData = await memoriesRes.json();
          this.memories = memData.memories || [];
        } else {
          this.memories = [];
        }
      } catch (e) {
        console.error('Failed to load person profile:', e);
      }
      this.loading = false;
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
    anchor: new Map(),       // anchor positions
    velocity: new Map(),     // per-node velocity params
    animationFrame: null,
    animationTime: 0,

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
        this.startAnimation();
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
      this.anchor.clear();
      this.velocity.clear();
      this.nodes.forEach((node, i) => {
        const angle = (i / this.nodes.length) * Math.PI * 2;
        const r = 150 + Math.random() * 100;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        this.positions.set(node.id, { x, y });
        this.anchor.set(node.id, { x, y });
        // independent per-node motion seed — barely perceptible drift
        this.velocity.set(node.id, {
          seed: Math.random(),
          freq: 0.00009 + Math.random() * 0.00007,
          amp: 0.25 + Math.random() * 0.25,
        });
      });
    },

    startAnimation() {
      if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
      const loop = (ts) => {
        this.animationTime = ts;
        this.updateMotion(ts);
        this.draw();
        this.animationFrame = requestAnimationFrame(loop);
      };
      this.animationFrame = requestAnimationFrame(loop);
    },

    updateMotion(ts) {
      const t = ts || performance.now();
      this.nodes.forEach(n => {
        if (this.dragNode && this.dragNode.id === n.id) return;
        const p = this.positions.get(n.id);
        const a = this.anchor.get(n.id);
        const v = this.velocity.get(n.id);
        if (!p || !a || !v) return;

        // barely perceptible drift: independent sine on each axis, different freq per node
        const ox = Math.sin(t * v.freq + v.seed * 11.1) * v.amp;
        const oy = Math.cos(t * v.freq * 0.87 + v.seed * 17.3) * v.amp;
        p.x = a.x + ox;
        p.y = a.y + oy;
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
        this.edges.forEach(e => {
          const ps = this.positions.get(e.source), pt = this.positions.get(e.target);
          if (!ps || !pt) return;
          let dx = pt.x - ps.x, dy = pt.y - ps.y;
          forces.get(e.source).fx += dx * attForce;
          forces.get(e.source).fy += dy * attForce;
          forces.get(e.target).fx -= dx * attForce;
          forces.get(e.target).fy -= dy * attForce;
        });
        const damp = 0.1;
        this.nodes.forEach(n => {
          const f = forces.get(n.id);
          const p = this.positions.get(n.id);
          if (!f || !p) return;
          p.x += f.fx * damp;
          p.y += f.fy * damp;
        });
      }
      // sync anchor after layout settlement
      this.nodes.forEach(n => {
        const p = this.positions.get(n.id);
        const a = this.anchor.get(n.id);
        if (p && a) { a.x = p.x; a.y = p.y; }
      });
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

      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      const t = this.animationTime || performance.now();

      // compute focus neighborhood
      const focus = this.hoveredNode || this.selectedNode || null;
      const neighbors = new Set();
      const activeEdges = new Set();
      if (focus) {
        this.edges.forEach((e, i) => {
          if (e.source === focus.id) { neighbors.add(e.target); activeEdges.add(i); }
          if (e.target === focus.id) { neighbors.add(e.source); activeEdges.add(i); }
        });
        neighbors.add(focus.id);
      }

      // Edges
      this.edges.forEach((e, i) => {
        const ps = this.positions.get(e.source), pt = this.positions.get(e.target);
        if (!ps || !pt) return;
        const active = activeEdges.has(i);

        if (active) {
          ctx.strokeStyle = isDark ? 'rgba(0,212,255,0.7)' : 'rgba(0,136,170,0.6)';
          ctx.lineWidth = 2 / this.zoom;
        } else {
          if (focus) {
            ctx.strokeStyle = isDark ? 'rgba(0,212,255,0.06)' : 'rgba(0,136,170,0.05)';
            ctx.lineWidth = 0.6 / this.zoom;
          } else {
            // very slow barely-perceptible pulse per edge (each edge offset by index)
            const pulse = (Math.sin(t * 0.00022 + i * 1.3) + 1) * 0.5;
            const alpha = (isDark ? 0.16 : 0.13) + pulse * 0.06;
            ctx.strokeStyle = isDark ? `rgba(0,212,255,${alpha.toFixed(3)})` : `rgba(0,136,170,${alpha.toFixed(3)})`;
            ctx.lineWidth = (0.7 + pulse * 0.3) / this.zoom;
          }
        }
        ctx.beginPath();
        ctx.moveTo(ps.x, ps.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      });

      // Nodes
      const searchQ = this.searchQuery.toLowerCase();
      this.nodes.forEach(n => {
        const p = this.positions.get(n.id);
        if (!p) return;
        const isHovered = this.hoveredNode && this.hoveredNode.id === n.id;
        const isSelected = this.selectedNode && this.selectedNode.id === n.id;
        const isNeighbor = neighbors.has(n.id);

        // Breathing radius: each node on its own slow sine (~1% range)
        const v = this.velocity.get(n.id) || { seed: 0 };
        const breathe = 1 + Math.sin(t * 0.00035 + v.seed * 11.7) * 0.010;
        const r = (n.size || 6) * (isHovered || isSelected ? 1.5 : breathe);

        // Dim non-focus nodes when hovering
        let alpha = 1;
        if (searchQ) {
          const match = n.fullLabel.toLowerCase().includes(searchQ);
          alpha = match ? 1 : 0.12;
        } else if (focus) {
          alpha = isHovered || isSelected || isNeighbor ? 1 : 0.18;
        }
        ctx.globalAlpha = alpha;

        // Glow ring for hovered/selected
        if (isHovered || isSelected) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 5 / this.zoom, 0, Math.PI * 2);
          ctx.fillStyle = isDark ? 'rgba(0,212,255,0.14)' : 'rgba(0,136,170,0.12)';
          ctx.fill();
        }

        // Node body
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.color || '#888888';
        ctx.fill();

        // Stroke for focus/selection
        if (isHovered || isSelected) {
          ctx.strokeStyle = isDark ? '#f0f0f0' : '#1a1a1a';
          ctx.lineWidth = 2 / this.zoom;
          ctx.stroke();
        } else if (isNeighbor && !focus?.id === n.id) {
          ctx.strokeStyle = isDark ? 'rgba(0,212,255,0.65)' : 'rgba(0,136,170,0.55)';
          ctx.lineWidth = 1.8 / this.zoom;
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
        const a = this.anchor.get(this.dragNode.id);
        if (p) { p.x = gp.x; p.y = gp.y; }
        if (a) { a.x = gp.x; a.y = gp.y; }
      } else if (this.dragging) {
        this.pan.x += e.clientX - this.lastMouse.x;
        this.pan.y += e.clientY - this.lastMouse.y;
      } else {
        const node = this.findNodeAt(gp.x, gp.y);
        if (node !== this.hoveredNode) {
          this.hoveredNode = node;
          const sr = rect.width > 0 ? e.clientX - rect.left + 10 : 0;
          const st = rect.height > 0 ? e.clientY - rect.top + 10 : 0;
          this.tooltipStyle = `top:${st}px;left:${sr}px;`;
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

function simpleMarkdown(md) {
  if (!md) return '';
  var html = md;
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^\- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p><(h[2-4]|ul|pre)/g, '<$1');
  html = html.replace(/<\/(h[2-4]|ul|pre)><\/p>/g, '</$1>');
  return html;
}

function chatScreen() {
  return {
    messages: [],
    inputText: '',
    waiting: false,
    streamingText: '',
    currentAssistantId: null,
    provider: '',
    model: '',
    eventSource: null,
    scrollCheckTimer: null,

    renderMarkdown(md) { return simpleMarkdown(md); },

    formatTime(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    throttledScrollCheck() {
      if (this.scrollCheckTimer) return;
      var self = this;
      this.scrollCheckTimer = setTimeout(function() { self.scrollCheckTimer = null; }, 100);
    },

    scrollToBottom() {
      var el = this.$refs.messagesContainer;
      if (el) {
        requestAnimationFrame(function() { el.scrollTop = el.scrollHeight; });
      }
    },

    init() {
      this.connectSSE();
      this.$refs.chatInput?.focus();
    },

    connectSSE() {
      var self = this;
      if (this.eventSource) { this.eventSource.close(); }
      this.eventSource = new EventSource('/api/chat/events');
      this.eventSource.addEventListener('message', function(e) {
        try {
          var evt = JSON.parse(e.data);
          self.handleEvent(evt);
        } catch (err) { console.error('SSE parse error:', err); }
      });
      this.eventSource.addEventListener('error', function() {
        setTimeout(function() { self.connectSSE(); }, 3000);
      });
    },

    handleEvent(evt) {
      var self = this;
      switch (evt.type) {
        case 'thinking':
          this.waiting = true;
          this.scrollToBottom();
          break;

        case 'provider':
          this.provider = evt.data.name || '';
          this.model = evt.data.model || '';
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) { msg.provider = evt.data.name; msg.model = evt.data.model; }
          }
          break;

        case 'step_start':
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              if (!msg.steps) msg.steps = [];
              msg.steps.push({ tool: evt.data.tool, label: evt.data.label, open: false });
            }
          }
          this.scrollToBottom();
          break;

        case 'step_done':
          break;

        case 'text_delta':
          this.waiting = false;
          this.streamingText += (evt.data.text || '');
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              msg.content = self.streamingText;
              msg.streaming = true;
            }
          }
          this.scrollToBottom();
          break;

        case 'text_done':
          this.waiting = false;
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              if (evt.data.fullText && !msg.content) msg.content = evt.data.fullText;
              msg.streaming = false;
              msg.elapsedMs = evt.data.elapsedMs || msg.elapsedMs;
              if (evt.data.provider) { msg.provider = evt.data.provider; msg.model = evt.data.model; }
            }
          }
          this.streamingText = '';
          this.currentAssistantId = null;
          this.scrollToBottom();
          break;

        case 'permission_request':
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              if (!msg.permissions) msg.permissions = [];
              msg.permissions.push({ id: evt.data.id, prompt: evt.data.prompt, options: evt.data.options, resolved: false, resolvedAction: '' });
            }
          }
          this.scrollToBottom();
          break;

        case 'permission_continue':
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              if (!msg.permissions) msg.permissions = [];
              msg.permissions.push({ id: evt.data.id, prompt: evt.data.question, options: evt.data.options, resolved: false, resolvedAction: '' });
            }
          }
          this.scrollToBottom();
          break;

        case 'permission_mode':
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              if (!msg.permissions) msg.permissions = [];
              msg.permissions.push({ id: evt.data.id, prompt: 'Choose permission mode', options: evt.data.options, resolved: false, resolvedAction: '' });
            }
          }
          this.scrollToBottom();
          break;

        case 'loop_warning':
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              msg.content += '\\n\\n⚠ ' + (evt.data.message || 'Loop detected');
            }
          }
          break;

        case 'error':
          this.waiting = false;
          if (this.currentAssistantId) {
            var msg = this.messages.find(function(m) { return m.id === self.currentAssistantId; });
            if (msg) {
              msg.content = 'Error: ' + (evt.data.message || 'Unknown error');
              msg.streaming = false;
            }
          } else {
            this.messages.push({
              id: 'err_' + Date.now(), role: 'assistant', content: 'Error: ' + (evt.data.message || 'Unknown error'),
              timestamp: Date.now(), steps: [], permissions: [], streaming: false
            });
          }
          break;

        case 'connected':
          break;
      }
    },

    sendMessage() {
      if (!this.inputText.trim() || this.waiting) return;
      var text = this.inputText.trim();
      this.inputText = '';
      this.messages.push({
        id: 'user_' + Date.now(), role: 'user', content: text,
        timestamp: Date.now(), steps: [], permissions: []
      });

      this.currentAssistantId = 'asst_' + Date.now();
      this.messages.push({
        id: this.currentAssistantId, role: 'assistant', content: '',
        timestamp: Date.now(), steps: [], permissions: [],
        streaming: true, provider: this.provider, model: this.model,
        prompt: text
      });

      this.waiting = true;
      this.streamingText = '';
      this.scrollToBottom();

      var self = this;
      fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text })
      }).catch(function(err) {
        self.waiting = false;
        var msg = self.messages.find(function(m) { return m.id === self.currentAssistantId; });
        if (msg) { msg.content = 'Failed to send: ' + err.message; msg.streaming = false; }
      });
    },

    resolvePermission(permId, action) {
      var self = this;
      this.messages.forEach(function(msg) {
        if (msg.permissions) {
          msg.permissions.forEach(function(perm) {
            if (perm.id === permId) {
              perm.resolved = true;
              perm.resolvedAction = action;
            }
          });
        }
      });
      fetch('/api/chat/permission/' + permId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      }).catch(function(err) { console.error('Permission resolve error:', err); });
    },

    clearChat() {
      this.messages = [];
      this.streamingText = '';
      this.currentAssistantId = null;
      this.waiting = false;
    },
  };
}
