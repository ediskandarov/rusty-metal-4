import type { ControlsStore } from "../state/controls.ts";

const fullTurn = 4096;
const anglePerPixel = fullTurn / 480;
const maxRise = fullTurn / 8;
const maxDrop = fullTurn / 24;
const clickDurationMs = 180;
const clickMovementPx = 6;
const returnDurationMs = 240;
const swipeQuietMs = 100;

export function initializeMouseLook(canvas: HTMLCanvasElement, controls: ControlsStore) {
  let available = false;
  let mode: "mouse" | "trackpad" | null = null;
  let locked = false;
  let press: { startedAt: number; movement: number } | null = null;
  let lastX = 0;
  let lastY = 0;
  let yaw = 0;
  let pitch = 0;
  let releasedAt = 0;
  let lastWheelAt = -Infinity;
  let ignoreWheelUntil = -Infinity;
  let escapeHeld = false;

  function begin(next: "mouse" | "trackpad") {
    if (mode === next) return;
    const weight = returnWeight();
    yaw *= weight;
    pitch *= weight;
    mode = next;
  }

  function stop() {
    press = null;
    if (mode === "trackpad") ignoreWheelUntil = lastWheelAt + swipeQuietMs;
    if (mode) releasedAt = performance.now();
    mode = null;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }

  function reset() {
    stop();
    yaw = pitch = 0;
  }

  function rotate(dx: number, dy: number) {
    yaw += dx * anglePerPixel;
    yaw -= fullTurn * Math.floor((yaw + fullTurn / 2) / fullTurn);
    pitch = Math.max(-maxRise, Math.min(maxDrop, pitch - dy * anglePerPixel));
  }

  function syncTrackpadGesture() {
    document.documentElement.toggleAttribute(
      "data-trackpad-look",
      available && controls.getState().trackpadLook,
    );
  }

  controls.subscribe((state, previous) => {
    if (state.trackpadLook === previous.trackpadLook) return;
    reset();
    syncTrackpadGesture();
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!available || !controls.getState().trackpadLook || event.ctrlKey) return;
      const unit = event.deltaMode;
      const unitToPixel =
        unit === WheelEvent.DOM_DELTA_LINE
          ? 16
          : unit === WheelEvent.DOM_DELTA_PAGE
            ? canvas.clientHeight
            : 1;
      const dx = event.deltaX * unitToPixel;
      const dy = event.deltaY * unitToPixel;
      if (!dx && !dy) return;
      event.preventDefault();
      lastWheelAt = event.timeStamp;
      // Momentum events can outlive the recenter click. A quiet gap starts a new swipe.
      if (lastWheelAt < ignoreWheelUntil) {
        ignoreWheelUntil = lastWheelAt + swipeQuietMs;
        return;
      }

      begin("trackpad");
      // Natural scrolling reports the direction of scroll, opposite to finger movement.
      rotate(-dx, -dy);
    },
    { passive: false },
  );

  canvas.addEventListener("mousedown", (event) => {
    if (!available || event.button !== 2) return;
    press = { startedAt: event.timeStamp, movement: 0 };
    lastX = event.clientX;
    lastY = event.clientY;
  });

  window.addEventListener("mousemove", (event) => {
    if (!press && mode !== "mouse") return;
    const dx = locked ? event.movementX : event.clientX - lastX;
    const dy = locked ? event.movementY : event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (press) press.movement += Math.hypot(dx, dy);
    if (mode === "mouse") rotate(dx, dy);
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button !== 2 || !press) return;
    const { startedAt, movement } = press;
    press = null;
    if (
      !available ||
      event.target !== canvas ||
      event.timeStamp - startedAt >= clickDurationMs ||
      movement > clickMovementPx
    )
      return;
    if (mode || controls.getState().trackpadLook) {
      stop();
      return;
    }

    begin("mouse");
    try {
      void canvas.requestPointerLock?.()?.catch(() => {});
    } catch {
      // Keep regular cursor movement available if the browser refuses pointer lock.
    }
  });

  document.addEventListener("pointerlockchange", () => {
    const hasLock = document.pointerLockElement === canvas;
    if (locked && !hasLock) stop();
    locked = hasLock;
    if (locked && mode !== "mouse") document.exitPointerLock();
  });

  canvas.addEventListener("pointercancel", reset);
  canvas.addEventListener("blur", reset);
  window.addEventListener("blur", () => {
    escapeHeld = false;
    reset();
  });
  document.addEventListener("visibilitychange", reset);
  document.addEventListener("fullscreenchange", reset);

  // Run before the fullscreen and game Escape handlers.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || (!mode && !escapeHeld)) return;
      escapeHeld = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "Escape" || !escapeHeld) return;
      escapeHeld = false;
      event.stopImmediatePropagation();
    },
    true,
  );

  function returnWeight() {
    if (mode) return 1;
    const remaining = Math.max(0, 1 - (performance.now() - releasedAt) / returnDurationMs);
    return remaining * remaining;
  }

  const host = globalThis as typeof globalThis & {
    tm4MouseLook?: (enabled: boolean) => number;
  };
  host.tm4MouseLook = (enabled) => {
    if (enabled !== available) {
      available = enabled;
      if (!available) reset();
      syncTrackpadGesture();
    }
    const weight = returnWeight();
    // The Wasm renderer receives yaw and pitch as two signed 16-bit angles.
    return (Math.round(pitch * weight) << 16) | (Math.round(yaw * weight) & 0xffff);
  };
}
