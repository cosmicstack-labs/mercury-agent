import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  banner: {},
  external: [
    "react",
    "ink",
    "grammy",
  ],
});