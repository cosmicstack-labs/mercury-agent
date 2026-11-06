// Mercury-native Hardlight checks. See LICENSE for upstream attribution.
const THRESHOLDS = Object.freeze({ text: 4.5, large_text: 3, ui: 3 });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (error) => ({ ok: false, error });
function luminance(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((c) => c + c).join('');
  const c = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
export function contrast(args) {
  if (!isObject(args) || Object.keys(args).some((k) => k !== 'pairs') || !Array.isArray(args.pairs) || args.pairs.length < 1 || args.pairs.length > 100)
    return fail('pairs must be an array of 1..100 opaque color pairs');
  const results = [];
  for (const [index, pair] of args.pairs.entries()) {
    if (!isObject(pair) || Object.keys(pair).some((k) => !['foreground', 'background', 'role', 'label'].includes(k)))
      return fail(`pairs[${index}] must contain only foreground, background, role and optional label`);
    for (const key of ['foreground', 'background']) {
      if (typeof pair[key] !== 'string' || !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(pair[key]))
        return fail(`pairs[${index}].${key} must be opaque #RGB or #RRGGBB`);
    }
    if (typeof pair.role !== 'string' || !has(THRESHOLDS, pair.role)) return fail(`pairs[${index}].role must be text, large_text or ui`);
    if (has(pair, 'label') && (typeof pair.label !== 'string' || pair.label.length > 500)) return fail(`pairs[${index}].label must be a string of at most 500 characters`);
    const a = luminance(pair.foreground), b = luminance(pair.background);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    results.push({ ...pair, ratio, threshold: THRESHOLDS[pair.role], status: ratio >= THRESHOLDS[pair.role] ? 'pass' : 'fail' });
  }
  return { ok: true, pairs: results, coverage: 'Opaque sRGB pairs only; roles supplied by caller. Not a WCAG conformance audit.' };
}
function string(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function fields(value, required, optional = []) {
  return isObject(value) && required.every((k) => has(value, k)) && Object.keys(value).every((k) => [...required, ...optional].includes(k));
}
export function navigation(args) {
  if (!fields(args, ['pages', 'tasks'], ['home'])) return fail('Expected pages, tasks and optional home');
  const { pages, tasks } = args;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 300 || !Array.isArray(tasks) || tasks.length > 100) return fail('Expected 1..300 pages and 0..100 tasks');
  const ids = new Set();
  let edges = 0;
  for (const page of pages) {
    if (!fields(page, ['id', 'label', 'links']) || !string(page.id, 200) || !string(page.label, 500) || ids.has(page.id)) return fail('Pages require unique IDs (1..200 chars), labels (1..500 chars) and links');
    ids.add(page.id);
    if (!Array.isArray(page.links) || page.links.length > 1000 || (edges += page.links.length) > 10000) return fail('At most 1000 links per page and 10000 links total');
    for (const link of page.links) {
      if (!fields(link, ['to', 'label']) || !string(link.to, 200) || !string(link.label, 500)) return fail('Links require a destination (1..200 chars) and label (1..500 chars)');
    }
  }
  const home = has(args, 'home') ? args.home : pages[0].id;
  if (!string(home, 200) || !ids.has(home)) return fail('home must reference a declared page ID');
  for (const task of tasks) {
    if (!fields(task, ['name', 'start', 'goal'], ['max_steps']) || !string(task.name, 500) || !string(task.start, 200) || !string(task.goal, 200) || !ids.has(task.start) || !ids.has(task.goal)) return fail('Tasks require name and declared start/goal page IDs');
    if (has(task, 'max_steps') && (!Number.isInteger(task.max_steps) || task.max_steps < 0 || task.max_steps > 1000000)) return fail('max_steps must be an integer in 0..1000000');
  }
  const adjacency = new Map(pages.map((p) => [p.id, p.links.filter((l) => ids.has(l.to)).map((l) => l.to)]));
  const unknown = [], ambiguous = [];
  for (const page of pages) {
    const labels = new Map();
    for (const link of page.links) {
      if (!ids.has(link.to)) unknown.push({ source: page.id, ...link });
      if (!labels.has(link.label)) labels.set(link.label, new Set());
      labels.get(link.label).add(link.to);
    }
    for (const [label, targets] of labels) if (targets.size > 1) ambiguous.push({ source: page.id, label, targets: [...targets] });
  }
  function search(start, goal) {
    const parents = new Map([[start, null]]), queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      if (node === goal) break;
      for (const target of adjacency.get(node)) if (!parents.has(target)) { parents.set(target, node); queue.push(target); }
    }
    if (goal === undefined) return parents;
    if (!parents.has(goal)) return null;
    const path = [];
    for (let node = goal; node !== null; node = parents.get(node)) path.push(node);
    return path.reverse();
  }
  const reachable = search(home), goals = new Set(tasks.map((t) => t.goal));
  const results = tasks.map((task) => {
    const path = search(task.start, task.goal), steps = path === null ? null : path.length - 1;
    return { ...task, path, steps, reachable: path !== null, over_budget: path !== null && has(task, 'max_steps') ? steps > task.max_steps : null };
  });
  return { ok: true, home, tasks: results, unknown_targets: unknown, ambiguous_labels: ambiguous,
    unreachable_pages: pages.filter((p) => !reachable.has(p.id)).map((p) => p.id),
    dead_ends: pages.filter((p) => !adjacency.get(p.id).length && !goals.has(p.id)).map((p) => p.id),
    coverage: { page_count: pages.length, edge_count: edges, known_edge_count: [...adjacency.values()].reduce((n, a) => n + a.length, 0) },
    limitations: ['Only declared links are analyzed. Structural paths are not usability certification.', 'Permissions, keyboard behavior, browser history and actual user success are not tested.'] };
}
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const pairSchema = objectSchema({
  foreground: { type: 'string', pattern: '^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$' },
  background: { type: 'string', pattern: '^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$' },
  role: { type: 'string', enum: ['text', 'large_text', 'ui'] }, label: { type: 'string', maxLength: 500 },
}, ['foreground', 'background', 'role']);
const linkSchema = objectSchema({ to: textSchema(200), label: textSchema(500) }, ['to', 'label']);
const pageSchema = objectSchema({ id: textSchema(200), label: textSchema(500), links: { type: 'array', items: linkSchema, maxItems: 1000 } }, ['id', 'label', 'links']);
const taskSchema = objectSchema({ name: textSchema(500), start: textSchema(200), goal: textSchema(200), max_steps: { type: 'integer', minimum: 0, maximum: 1000000 } }, ['name', 'start', 'goal']);
export function activate(ctx) {
  ctx.tools.register({ name: 'contrast', inputSchema: objectSchema({ pairs: { type: 'array', items: pairSchema, minItems: 1, maxItems: 100 } }, ['pairs']), execute: (args) => contrast(args) });
  ctx.tools.register({ name: 'navigation', inputSchema: objectSchema({ pages: { type: 'array', items: pageSchema, minItems: 1, maxItems: 300 }, tasks: { type: 'array', items: taskSchema, maxItems: 100 }, home: textSchema(200) }, ['pages', 'tasks']), execute: (args) => navigation(args) });
}
