/**
 * Degrade heavy DOM widget painting while the graph canvas keeps zooming.
 *
 * The ComfyUI frontend renders every DOM widget as a `position: fixed` overlay that is
 * positioned with `transform: scale(ds.scale)` and sized in graph units (see `DomWidgets`
 * and `useAbsolutePosition({ useTransform: true })` in the frontend bundle). Zooming never
 * reflows the widget, but it changes the *raster* scale of the whole widget surface on
 * every wheel tick, so Chromium repaints that surface again and again.
 *
 * Re-rastering is free for a text box and ruinous for the prompt manager's embedded
 * iframe: each preview `img` has to be re-scaled, and every card header/footer uses a
 * `backdrop-filter: blur()` that has to be re-composited at the new scale. That is what
 * makes canvas zooming collapse once the library grows, and `hideOnZoom` does not help
 * because it only reacts to the font-size LOD threshold (~0.57 zoom at DPR 1).
 *
 * The guard therefore switches the widget into a cheap rendering state for the duration
 * of the gesture:
 *   level 1 ("degraded"): drop the expensive paint (preview images, backdrop blur,
 *                         shadows) but keep every piece of information on screen;
 *   level 2 ("suspended"): additionally blank the results region only, keeping the
 *                         sidebar/toolbar/search readable. Entered only when the frames
 *                         measured during the gesture are still slow.
 *
 * Content classes are applied to the widget document root (same-origin iframe) so the
 * embedded app's own stylesheet can define exactly which parts get cheaper. Targets
 * without a `className` fall back to hiding the element, which is the safe behaviour for
 * plain DOM widgets.
 */

const DEFAULT_SETTLE_MS = 180;
/** A frame this slow during a zoom gesture means the degraded state is not enough yet. */
const SLOW_FRAME_MS = 45;
/** Consecutive slow frames required before escalating to the suspended state. */
const SLOW_FRAMES_TO_ESCALATE = 2;

/** Duck-typed lookup so the module also works where `Element` is not a global. */
function resolveCanvasElement(app) {
  for (const candidate of [app?.canvasEl, app?.canvas?.canvas]) {
    if (candidate && typeof candidate.addEventListener === "function") return candidate;
  }
  return null;
}

function normalizeTarget(target) {
  if (target && typeof target === "object" && "element" in target) {
    return {
      element: target.element ?? null,
      className: target.className || "",
      hardClassName: target.hardClassName || "",
    };
  }
  return { element: target ?? null, className: "", hardClassName: "" };
}

function contentDocumentOf(element) {
  if (!element) return null;
  try {
    return element.contentDocument || element.contentWindow?.document || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.app ComfyUI `app` singleton (needs `app.canvas.ds`).
 * @param {Array<Element | { element: Element, className?: string, hardClassName?: string }>} options.targets
 *   Widget elements. A `className` target is degraded through its document root.
 * @param {number} [options.settleMs] Idle delay before the full quality state returns.
 * @param {boolean} [options.escalate] Allow the slow-frame escalation to level 2.
 * @returns {{ ensure: () => boolean, dispose: () => void }}
 */
export function guardDomWidgetDuringZoom({
  app,
  targets,
  settleMs = DEFAULT_SETTLE_MS,
  escalate = true,
} = {}) {
  const normalized = (Array.isArray(targets) ? targets : [targets])
    .map(normalizeTarget)
    .filter((target) => target.element);
  if (!normalized.length || !app) return { ensure: () => false, dispose() {} };

  const originalVisibility = new Map();
  /** @type {Array<{ owner: object, key: string, wrapper: Function, previous: Function | undefined }>} */
  const chainedHooks = [];
  let settleTimer = 0;
  let disposed = false;
  let level = 0;
  let lastScale = null;
  let hookedDs = null;
  let wheelElement = null;
  let wheelFrame = 0;
  let monitorFrame = 0;
  let lastFrameTime = 0;
  let slowFrames = 0;

  const stopFrameMonitor = () => {
    if (monitorFrame) cancelAnimationFrame(monitorFrame);
    monitorFrame = 0;
    lastFrameTime = 0;
    slowFrames = 0;
  };

  /**
   * Apply a rendering level. 0 = full quality, 1 = degraded, 2 = suspended.
   */
  const applyLevel = (next) => {
    if (disposed || next === level) return;
    if (next > level && next >= 2 && !escalate) next = 1;
    level = next;

    for (const target of normalized) {
      const doc = target.className ? contentDocumentOf(target.element) : null;
      const root = doc?.documentElement || null;
      const classDriven = Boolean(target.className && root);

      if (classDriven) {
        root.classList.toggle(target.className, level >= 1);
        if (target.hardClassName) root.classList.toggle(target.hardClassName, level >= 2);
        // A class-driven target keeps the element itself painted, that is the point.
        if (originalVisibility.has(target.element)) {
          target.element.style.visibility = originalVisibility.get(target.element) ?? "";
          originalVisibility.delete(target.element);
        }
        continue;
      }

      // No document class available: fall back to hiding the element. A class-less target
      // is hidden already at level 1, a class target only once the fallback level is needed.
      const shouldHide = level > 0 && (level >= 2 || !target.className);
      if (shouldHide) {
        if (!originalVisibility.has(target.element)) {
          originalVisibility.set(target.element, target.element.style.visibility);
        }
        target.element.style.visibility = "hidden";
      } else if (originalVisibility.has(target.element)) {
        target.element.style.visibility = originalVisibility.get(target.element) ?? "";
        originalVisibility.delete(target.element);
      }
    }
  };

  const restore = () => {
    settleTimer = 0;
    stopFrameMonitor();
    applyLevel(0);
  };

  const scheduleRestore = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(restore, settleMs);
  };

  /**
   * Watch the frames that the zoom actually produces. If the degraded state still misses
   * the frame budget twice in a row, escalate to the suspended state for this gesture.
   */
  const watchFrames = () => {
    if (monitorFrame || !escalate) return;
    lastFrameTime = 0;
    slowFrames = 0;
    const tick = (time) => {
      monitorFrame = 0;
      if (disposed || level === 0) return;
      if (lastFrameTime) {
        const delta = time - lastFrameTime;
        slowFrames = delta > SLOW_FRAME_MS ? slowFrames + 1 : 0;
        if (slowFrames >= SLOW_FRAMES_TO_ESCALATE && level < 2) {
          applyLevel(2);
          return;
        }
      }
      lastFrameTime = time;
      monitorFrame = requestAnimationFrame(tick);
    };
    monitorFrame = requestAnimationFrame(tick);
  };

  const notifyScaleChange = () => {
    if (disposed) return;
    const scale = Number(app.canvas?.ds?.scale);
    if (!Number.isFinite(scale)) return;
    if (lastScale === null) {
      lastScale = scale;
      return;
    }
    if (Math.abs(scale - lastScale) < 1e-6) return;
    lastScale = scale;
    applyLevel(Math.max(level, 1));
    watchFrames();
    scheduleRestore();
  };

  /**
   * Chain a callback instead of replacing it. Both `onredraw` (zoom/pan) and `onChanged`
   * (per-changed-frame viewport update, also used by programmatic zoom and zoom-to-fit
   * animations) are owned by the frontend or by other extensions, so never assign them
   * blindly.
   */
  const chainCallback = (owner, key) => {
    const previous = owner?.[key];
    if (typeof previous === "function" && previous.__pm4aZoomPaintGuard === key) return;
    const wrapper = function onCanvasTransformChangedForZoomGuard() {
      notifyScaleChange();
      return previous?.apply(this, arguments);
    };
    wrapper.__pm4aZoomPaintGuard = key;
    owner[key] = wrapper;
    chainedHooks.push({ owner, key, wrapper, previous });
  };

  const unhook = () => {
    for (const { owner, key, wrapper, previous } of chainedHooks.splice(0)) {
      if (owner?.[key] === wrapper) owner[key] = previous;
    }
  };

  // `DragAndScale.changeScale()` funnels wheel zoom, drag-zoom and `canvas.setZoom()`, and
  // `computeVisibleArea()` reports every changed frame (including direct `ds.scale`
  // assignments from zoom-to-fit). Hooking both keeps the guard independent of the path
  // the frontend happens to use.
  const ensureHooked = () => {
    if (disposed) return;
    const ds = app.canvas?.ds;
    if (!ds || ds === hookedDs) return;
    unhook();
    hookedDs = ds;
    lastScale = Number.isFinite(Number(ds.scale)) ? Number(ds.scale) : null;
    chainCallback(ds, "onredraw");
    chainCallback(ds, "onChanged");
  };

  // Last-resort fallback for a frontend that stops calling either callback: sample the
  // scale once per animation frame after a wheel event on the canvas.
  const onWheel = () => {
    if (disposed || wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      notifyScaleChange();
    });
  };

  const ensureWheelListener = () => {
    if (wheelElement || disposed) return;
    const element = resolveCanvasElement(app);
    if (!element) return;
    wheelElement = element;
    wheelElement.addEventListener("wheel", onWheel, { passive: true, capture: true });
  };

  const ensure = () => {
    ensureHooked();
    ensureWheelListener();
    return Boolean(hookedDs && wheelElement);
  };

  ensure();

  return {
    /**
     * Re-install the hooks when the canvas was not ready yet, or when the frontend
     * replaced `app.canvas.ds` (canvas rebuild).
     */
    ensure,
    dispose() {
      if (disposed) return;
      if (settleTimer) clearTimeout(settleTimer);
      if (wheelFrame) cancelAnimationFrame(wheelFrame);
      settleTimer = 0;
      wheelFrame = 0;
      if (wheelElement) {
        wheelElement.removeEventListener("wheel", onWheel, { capture: true });
        wheelElement = null;
      }
      stopFrameMonitor();
      unhook();
      hookedDs = null;
      applyLevel(0);
      disposed = true;
    },
  };
}
