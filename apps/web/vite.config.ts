import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:30001";

// The web dev server proxies API + SSE traffic to the API app so the browser
// only talks to one origin (no CORS, and EventSource works cleanly).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // SMB does not support inotify-style watchers; poll instead.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/auth": proxyTarget,
      "/setup": proxyTarget,
      "/health": proxyTarget,
      "/tasks": proxyTarget,
      "/summary": proxyTarget,
      "/results": proxyTarget,
      "/providers": proxyTarget,
      "/repositories": proxyTarget,
      "/logs": proxyTarget,
      "/vector": proxyTarget,
      "/config": proxyTarget,
      "/settings": proxyTarget,
      "/memory": proxyTarget,
      "/users": proxyTarget,
      "/audit": proxyTarget,
      "/capabilities": proxyTarget,
      "/label-rules": proxyTarget,
      "/backup": proxyTarget,
      "/index": proxyTarget,
      "/update": proxyTarget,
      "/events": { target: proxyTarget, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: false,
  },
});