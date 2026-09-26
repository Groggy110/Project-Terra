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

// SANDBOX START — temporary Style Sandbox, opened from the ••• menu ("Style
// editor") or with ?sandbox=1. Its code is a separate chunk, fetched only when
// opened. Removal: delete src/sandbox/style/ and the two SANDBOX blocks (here
// and in ui/app.js #menu) — see src/sandbox/style/REMOVAL.md.
// A glob rather than import(), so a deleted folder is simply an empty match
// and the menu item disappears with it.
const loadStyleSandbox = Object.values(import.meta.glob("./sandbox/style/index.js"))[0];
if (loadStyleSandbox) {
  let panel = null;
  let loading = null;
  window.terraStyleEditor = {
    get open() {
      return !!panel && panel.gui.domElement.style.display !== "none";
    },
    async toggle() {
      if (!panel) {
        loading ??= loadStyleSandbox().then((m) => m.mount(app));
        panel = await loading.catch((err) => {
          loading = null;
          console.error("[terra] style sandbox", err);
          return null;
        });
        return;
      }
      const el = panel.gui.domElement;
      el.style.display = el.style.display === "none" ? "" : "none";
    },
  };
  if (new URLSearchParams(location.search).get("sandbox") === "1") window.terraStyleEditor.toggle();
}
// SANDBOX END
