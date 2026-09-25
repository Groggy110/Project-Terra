/**
 * Sandbox entry point.
 *
 * It boots the *real* app — same App, same Globe, same stylesheets — and then
 * mounts the sandbox over the top of it. Nothing in src/ui or src/globe is
 * modified to make this work, so whatever you see here is what index.html
 * would do, minus the sandbox chrome.
 */
import { App } from "../ui/app.js";
import { Sandbox } from "./sandbox.js";
import "./styles.css";

// A design sandbox with an empty globe is no use, so the fictional set is the
// default here. `?live` opts back into whatever the backend has.
const params = new URLSearchParams(location.search);
if (!params.has("live") && !params.has("demo")) {
  params.set("demo", "1");
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

const app = new App();
window.terra = app;

/**
 * Mounted whether or not the globe came up: if WebGL or the baked textures are
 * missing, the design half of the sandbox is still perfectly usable and the
 * capture half simply has no camera to drive.
 */
function mount() {
  const sandbox = new Sandbox(app).mount();
  window.sbx = sandbox;
  return sandbox;
}

app.start().then(mount, (err) => {
  console.error("[terra] failed to start", err);
  mount();
});
