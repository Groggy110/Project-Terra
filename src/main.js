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
