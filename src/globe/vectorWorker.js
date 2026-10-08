/**
 * Paints the vector window off the main thread.
 *
 * A window at 1:10m is the land fill and every coast, border and river that
 * crosses it — whole continents traced ring by ring — and on the page that
 * was tens of milliseconds inside a frame, several times over every zoom: the
 * stalls in the middle of coming in. Here it costs the page nothing. The page
 * asks with a plan (VectorPainter.repaint) and gets back two bitmaps, which it
 * swaps in together with the window they were painted for, so the ground
 * never shows ink from one window over the mask of another.
 */
import { loadSet, paintLines, paintMask } from "./vectorRaster.js";

const sets = new Map();
const loading = new Map();
let lines = null;
let mask = null;

function set(base, scale) {
  if (sets.has(scale)) return Promise.resolve(sets.get(scale));
  if (!loading.has(scale)) {
    loading.set(
      scale,
      loadSet(base, scale).then((s) => {
        sets.set(scale, s);
        loading.delete(scale);
        return s;
      }),
    );
  }
  return loading.get(scale);
}

self.onmessage = async ({ data: job }) => {
  try {
    const s = await set(job.base, job.scale);
    if (!lines || lines.width !== job.view.w || lines.height !== job.view.h) {
      lines = new OffscreenCanvas(job.view.w, job.view.h);
      mask = new OffscreenCanvas(job.view.w, job.view.h);
      lines.ctx = lines.getContext("2d", { alpha: true });
      mask.ctx = mask.getContext("2d", { alpha: false });
    }
    const t0 = performance.now();
    let features = paintMask(mask.ctx, s, job.view);
    features += paintLines(lines.ctx, s, job.view, job.style, job.fade, job.texelPerPx);
    // Handed over as they are, without a copy: the ink premultiplied, which
    // is how the page uploads its own paint too (VectorPainter), and the mask
    // opaque, where premultiplying changes nothing.
    const l = lines.transferToImageBitmap();
    const m = mask.transferToImageBitmap();
    const ms = performance.now() - t0;
    self.postMessage({ id: job.id, lines: l, mask: m, features, ms }, [l, m]);
  } catch (err) {
    self.postMessage({ id: job.id, error: String(err?.message || err) });
  }
};
