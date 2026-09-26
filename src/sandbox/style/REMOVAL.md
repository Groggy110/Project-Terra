# Removing the Style Sandbox

The Style Sandbox is temporary. It is a lil-gui panel over `STYLE`, opened with
`?sandbox=1`. Removing it takes about two minutes and changes nothing for
visitors: the panel is never loaded without the flag.

## What to keep

These files are **not** part of the sandbox. They are the permanent style
system, and the app needs them:

- `src/style/styleConfig.js` holds `STYLE`, the single source of truth, and `STYLE_VERSION`.
- `src/style/applyStyle.js` has `applyStyle()`, `onStyle()` and `mergeInto()`.
- `src/style/css.js` writes STYLE's CSS half as custom properties.
- `src/style/stars.js` makes the procedural star sheet.
- `src/globe/shaders/grade.glsl`, `effects.glsl` and `post.frag.glsl` hold the optional grade, the extra lights and fog, and the vignette/grain pass. All are off by default.
- `src/globe/postchain.js` is the render-target path for bloom, chromatic aberration and FXAA / no-AA. It is only used while one of those is on.
- `src/globe/nightlights.js` paints the city-lights texture from places.json. It only runs when night lights are switched on.
- The STYLE wiring in `globe.js`, `earth.js`, `controls.js`, `vectors.js`, `labels.js`, the shaders, `base.css`, `globe.css` and `ui/app.js`.

## Everything the sandbox added

| What | Where |
| --- | --- |
| Sandbox code | `src/sandbox/style/` (`index.js`, `panel.js`, `tools.js`, `sandbox.css`, this file) |
| Entry point | one block in `src/main.js`, between `// SANDBOX START` and `// SANDBOX END` |
| Dependency | `lil-gui` in `devDependencies` (package.json and package-lock.json) |
| Browser storage | localStorage key `terraSandbox` (presets, the export note, panel position) |
| Global | `window.terraSandbox` (the panel instance, set only when the panel is open) |

No other file references the sandbox. `src/sandbox/` also holds the older
design & capture sandbox (`sandbox.html`), which is separate. Leave it alone
unless you mean to remove that one too.

## Removal steps

1. Apply your final settings first. Open the exported
   `terra-style-settings.json` and copy its `style` values into `STYLE` in
   `src/style/styleConfig.js`. Bump `STYLE_VERSION` if you renamed any keys.
2. Delete the folder:
   ```sh
   rm -rf src/sandbox/style
   ```
3. Delete the block in `src/main.js` from `// SANDBOX START` to
   `// SANDBOX END`, inclusive. (The block uses `import.meta.glob`, so the build
   still succeeds if you forget this step. It just matches nothing.)
4. Remove the dependency:
   ```sh
   npm uninstall lil-gui
   ```
5. Optionally, clear the stored presets in any browser that used the panel:
   ```js
   localStorage.removeItem("terraSandbox")
   ```
6. Check it:
   ```sh
   npm run build
   grep -rn "sandbox/style\|lil-gui\|terraSandbox" src package.json
   ```
   The grep should print nothing. The site should look and behave exactly as
   it did with the panel closed.
