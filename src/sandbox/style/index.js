/**
 * Style Sandbox — a temporary live control panel over STYLE.
 *
 * Loaded only by the guarded import in src/main.js (?sandbox=1); nothing else
 * in the app knows this folder exists. Delete the folder and that block, and
 * the app is exactly as it was: see REMOVAL.md.
 */
import { StylePanel } from "./panel.js";
import "./sandbox.css";

/** Waits for the globe to have its meshes, then mounts the panel over the app. */
export function mount(app) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (app.globe?.earth) {
        const panel = new StylePanel(app).mount();
        window.terraSandbox = panel;
        resolve(panel);
      } else if (performance.now() - started > 60000) {
        reject(new Error("[style sandbox] the globe never started"));
      } else {
        setTimeout(poll, 100);
      }
    };
    poll();
  });
}
