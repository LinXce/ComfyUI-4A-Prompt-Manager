/**
 * Spread the expensive "show the preview images again" work over several frames.
 *
 * The node wrapper puts the embedded page into a cheap rendering state while the ComfyUI
 * canvas is being zoomed (`pm4a-canvas-zooming`, see
 * `web/comfyui/dom_widget_zoom_guard.js`), which hides every preview image. Dropping that
 * class reveals all of them in a single frame: the browser has to decode and raster every
 * visible thumbnail at once, and that one long frame is exactly what feels like a freeze.
 *
 * This governor watches for the class to disappear, keeps the images hidden with an inline
 * style for one more moment (so the reveal does not flash), and then hands them back a few
 * at a time, nearest to the viewport first. The batch size adapts to the measured frame
 * time, so a slow machine gets a longer, smoother reveal instead of dropped frames.
 *
 * Images created later (infinite scroll) join the same queue while a reveal is running, so
 * appending a page of cards can never produce one huge decode burst either.
 */

const SUSPEND_CLASS = "pm4a-canvas-zooming";
const RETAIN_CLASS = "pm4a-reveal-pending";
const PREVIEW_SELECTOR = ".prompt-list .card-preview img";

const MIN_BATCH = 1;
const MAX_BATCH = 8;
const START_BATCH = 3;
/** Frame time above this means the last batch was too greedy. */
const SLOW_FRAME_MS = 40;
/** Frame time below this means there is headroom for a larger batch. */
const FAST_FRAME_MS = 22;

/**
 * @param {object} [options]
 * @param {Document} [options.document] Document to observe (defaults to the page's own).
 * @returns {{ track: (image: Element) => void, dispose: () => void }}
 */
export function installPreviewPaintGovernor({ document: doc = globalThis.document } = {}) {
  const view = doc?.defaultView;
  if (!doc || !view || typeof view.requestAnimationFrame !== "function") {
    return { track() {}, dispose() {} };
  }

  const root = doc.documentElement;
  const libraryPane = doc.getElementById("library-pane");
  const listElement = () => doc.getElementById("prompt-list");

  /** Images close enough to the viewport that revealing them costs real paint work. */
  const nearViewport = new WeakSet();
  const intersectionObserver = typeof view.IntersectionObserver === "function"
    ? new view.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) nearViewport.add(entry.target);
          else nearViewport.delete(entry.target);
        }
      }, { root: libraryPane || null, rootMargin: "240px 0px", threshold: 0 })
    : null;

  let queue = [];
  let frame = 0;
  let batch = START_BATCH;
  let lastFrameTime = 0;
  let suspended = false;
  let disposed = false;

  const retain = (image) => {
    if (!image || image.classList.contains(RETAIN_CLASS)) return;
    image.classList.add(RETAIN_CLASS);
  };

  const release = (image) => {
    image.classList.remove(RETAIN_CLASS);
  };

  const stop = () => {
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    lastFrameTime = 0;
    batch = START_BATCH;
    queue = [];
  };

  const pump = (time) => {
    frame = 0;
    if (disposed) return;
    if (lastFrameTime) {
      const delta = time - lastFrameTime;
      if (delta > SLOW_FRAME_MS) batch = Math.max(MIN_BATCH, Math.floor(batch / 2));
      else if (delta < FAST_FRAME_MS) batch = Math.min(MAX_BATCH, batch + 1);
    }
    lastFrameTime = time;

    let shown = 0;
    while (shown < batch && queue.length) {
      const image = queue.shift();
      if (!image.isConnected) continue;
      release(image);
      shown += 1;
    }

    if (queue.length) {
      frame = view.requestAnimationFrame(pump);
    } else {
      lastFrameTime = 0;
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = view.requestAnimationFrame(pump);
  };

  /**
   * Reveal everything that is still held back, nearest images first. Elements that are far
   * off screen are cheap to release (their cards are `content-visibility: auto`), so they
   * simply wait at the end of the queue instead of delaying the visible ones.
   */
  const revealAll = () => {
    const list = listElement();
    if (!list) return;
    const images = Array.from(list.querySelectorAll(PREVIEW_SELECTOR));
    for (const image of images) retain(image);
    const visible = images.filter((image) => nearViewport.has(image));
    const rest = images.filter((image) => !nearViewport.has(image));
    queue = [...visible, ...rest];
    batch = START_BATCH;
    lastFrameTime = 0;
    schedule();
  };

  const onClassChange = () => {
    if (disposed) return;
    if (root.classList.contains(SUSPEND_CLASS)) {
      suspended = true;
      stop();
      return;
    }
    if (!suspended) return;
    suspended = false;
    revealAll();
  };

  const classObserver = typeof view.MutationObserver === "function"
    ? new view.MutationObserver(onClassChange)
    : null;
  classObserver?.observe(root, { attributes: true, attributeFilter: ["class"] });

  return {
    /** Register a preview image so it is observed and can join a running reveal. */
    track(image) {
      if (!image || disposed) return;
      intersectionObserver?.observe(image);
      // New cards created while a reveal is still draining must not jump the queue: the
      // decoder would otherwise handle a whole page of cards in one frame.
      if (queue.length) {
        retain(image);
        queue.push(image);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      classObserver?.disconnect();
      intersectionObserver?.disconnect();
      for (const image of listElement()?.querySelectorAll(`.${RETAIN_CLASS}`) ?? []) {
        release(image);
      }
    },
  };
}
