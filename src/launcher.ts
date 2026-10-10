/**
 * Mercury's entry point — `dist/index.js`, what the `mercury` bin, service
 * files and the daemon re-spawn all run. Deliberately tiny with no static
 * imports: Node evaluates every static import of a module before the
 * module's first line, so a version check inside the main bundle runs too
 * late on Node 16/18 (a dependency throws while loading, before Mercury can
 * say anything useful). The tsup banner puts the Node 22 check (ADR-019) at
 * the top of this file; only then is the real bundle loaded.
 */
await import(new URL('./mercury.js', import.meta.url).href);
