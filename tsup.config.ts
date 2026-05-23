import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  // Inject the version so standalone binaries (Bun --compile) can read it
  // without trying to load package.json from disk.
  define: {
    "globalThis.__MERCURY_VERSION__": JSON.stringify(pkg.version),
  },
  external: [
    "ai",
    "@ai-sdk/anthropic",
    "@ai-sdk/deepseek",
    "@ai-sdk/openai",
    "@grammyjs/auto-retry",
    "chalk",
    "commander",
    "dotenv",
    "grammy",
    "ink",
    "js-tiktoken",
    "marked",
    "node-cron",
    "ollama-ai-provider",
    "pino",
    "react",
    "react-dom",
    "yaml",
    "zod",
    "better-sqlite3",
    "@hono/node-server",
    "sql.js",
  ],
});
