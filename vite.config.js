import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The sandbox (sandbox.html) is a second entry point, and it is opt-in: a
 * plain `vite build` produces exactly the bundle it always did, with no
 * sandbox code in it. `npm run build:sandbox` sets TERRA_SANDBOX and emits
 * both pages.
 *
 * In dev there is nothing to opt into — Vite serves every HTML file in the
 * root, so /sandbox.html is simply there beside /.
 */
const sandbox = !!process.env.TERRA_SANDBOX;

export default defineConfig({
  server: { port: 5173, host: "127.0.0.1" },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
    ...(sandbox
      ? {
          rollupOptions: {
            input: {
              main: resolve(import.meta.dirname, "index.html"),
              sandbox: resolve(import.meta.dirname, "sandbox.html"),
            },
          },
        }
      : {}),
  },
});
