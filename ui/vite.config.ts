import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      workbox: {
        // Don't precache anything - always fetch fresh from network
        globPatterns: [],
        navigateFallback: null,
        runtimeCaching: [],
        // Take control immediately and skip waiting so updates apply on next load
        skipWaiting: true,
        clientsClaim: true,
        // Clean up any existing precaches from previous SW versions
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: "Mercury — AI Agent",
        short_name: "Mercury",
        description:
          "Soul-driven AI agent with persistent memory and multi-channel access",
        theme_color: "#00d4ff",
        background_color: "#0a0e14",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/logo-dark.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/logo-dark.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/logo-dark.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:6174",
        changeOrigin: true,
      },
      "/vendor": {
        target: "http://127.0.0.1:6174",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-motion": ["framer-motion"],
          "vendor-markdown": ["react-markdown", "remark-gfm"],
          "vendor-syntax": ["react-syntax-highlighter"],
          "vendor-dnd": ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities"],
          "vendor-radix": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-popover",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
            "@radix-ui/react-switch",
            "@radix-ui/react-collapsible",
            "@radix-ui/react-scroll-area",
            "@radix-ui/react-separator",
            "@radix-ui/react-avatar",
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-progress",
          ],
        },
      },
    },
  },
});
