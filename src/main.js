import { App } from "./ui/app.js";

const app = new App();

/**
 * Exposed deliberately, in dev and in a build. This is a demonstration piece
 * whose About dialog documents its own pipeline; a handle to poke at the
 * globe, the vector painter and the network model belongs with it.
 *
 *   terra.globe.debug(1)          // render one shader channel
 *   terra.globe.painter.stats     // last vector repaint
 *   terra.net.stats()             // network totals
 */
window.terra = app;

app.start().catch((err) => {
  console.error("[terra] failed to start", err);
});

// SANDBOX START — temporary Style Sandbox, loaded only with ?sandbox=1.
// Removal: delete src/sandbox/style/ and this block (src/sandbox/style/REMOVAL.md).
// A glob rather than import(), so a deleted folder is simply an empty match.
const styleSandbox = import.meta.glob("./sandbox/style/index.js");
if (new URLSearchParams(location.search).get("sandbox") === "1") {
  for (const load of Object.values(styleSandbox)) {
    load().then((m) => m.mount(app)).catch((err) => console.error("[terra] style sandbox", err));
  }
}
// SANDBOX END
