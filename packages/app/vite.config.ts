import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const OPENCODE_SERVER_PORT = process.env.OPENCODE_SERVER_PORT || "4096"
const OPENCODE_SERVER_HOST = process.env.OPENCODE_SERVER_HOST || "localhost"
const VITE_PUBLIC_HOST = process.env.VITE_PUBLIC_HOST || "v7ren.xyz"

export default defineConfig({
  plugins: [desktopPlugin] as any,
  base: "/",
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,

    // ✅ Fix: Tell browser to connect HMR WebSocket through the reverse proxy
    hmr: {
      host: VITE_PUBLIC_HOST,
      protocol: "wss",
      clientPort: 443,
    },

    proxy: {
      "/global": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/project": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/session": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/pty": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
        ws: true,
      },
      "/file": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/find": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/config": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/provider": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/mcp": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/question": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/permission": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/debug": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/agent": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/command": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/lsp": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/vcs": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/skill": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/path": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/tui": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/experimental": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/log": {
        target: `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "esnext",
    // sourcemap: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  optimizeDeps: {
    force: true,
  },
})