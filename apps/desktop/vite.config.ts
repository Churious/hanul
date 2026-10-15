import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;
const e2ePort = Number(process.env.HANUL_E2E_PORT);
const port = Number.isInteger(e2ePort) && e2ePort > 0 ? e2ePort : 1420;
const e2eDiagnostics = e2ePort > 0
  ? {
      name: "hanul-desktop-e2e-diagnostics",
      transformIndexHtml: {
        order: "pre" as const,
        handler: () => [{ tag: "script", attrs: { src: "/e2e/diagnostics.ts" }, injectTo: "head-prepend" as const }],
      },
    }
  : undefined;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), ...(e2eDiagnostics ? [e2eDiagnostics] : [])],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
