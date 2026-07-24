import { useEffect, type RefObject } from "react";

/** Below this speed (px/ms) at lift-off, don't glide at all. */
const FLING_MIN = 0.12;
/** Per-frame velocity decay for the glide, at 60fps. */
const FLING_DECAY = 0.94;
/** Stop the glide once it's crawling. */
const FLING_STOP = 0.02;

/**
 * Scrolls `ref` vertically with a **two-finger** drag, plus a short
 * inertial glide after a flick.
 *
 * Why this exists: on the Pi's touch panel a one-finger drag doesn't
 * pan the page — the webview delivers the touch to whatever card or
 * carousel is under it and never starts a scroll — so the feed was
 * unreachable past the first screen. Two fingers is also the gesture
 * that can't be confused with tapping a track, which matters on a
 * screen mounted in a car.
 *
 * The listener is non-passive because it has to `preventDefault()` any
 * native pan the webview *would* start, so the two don't both move the
 * scroller. Single-finger touches are ignored entirely and fall through
 * to normal tap/click handling.
 */
export function useTwoFingerScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let active = false;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let raf = 0;

    const midpointY = (touches: TouchList) =>
      (touches[0].clientY + touches[1].clientY) / 2;

    const stopGlide = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const glide = () => {
      raf = 0;
      if (Math.abs(velocity) < FLING_STOP) return;
      // 16ms ≈ one frame; velocity is px/ms.
      el.scrollTop += velocity * 16;
      velocity *= FLING_DECAY;
      raf = requestAnimationFrame(glide);
    };

    const onTouchStart = (e: TouchEvent) => {
      stopGlide();
      if (e.touches.length !== 2) {
        active = false;
        return;
      }
      active = true;
      lastY = midpointY(e.touches);
      lastT = e.timeStamp;
      velocity = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!active) return;
      // A finger lifted mid-gesture: wait for a fresh two-finger start
      // rather than jumping to a new midpoint.
      if (e.touches.length !== 2) {
        active = false;
        return;
      }
      const y = midpointY(e.touches);
      const dy = lastY - y;
      const dt = e.timeStamp - lastT;
      lastY = y;
      lastT = e.timeStamp;
      if (dt > 0) velocity = dy / dt;
      el.scrollTop += dy;
      // Only cancelable while the webview hasn't already claimed the
      // gesture; calling it unconditionally logs a console warning.
      if (e.cancelable) e.preventDefault();
    };

    const onTouchEnd = () => {
      if (!active) return;
      active = false;
      if (Math.abs(velocity) >= FLING_MIN) {
        stopGlide();
        raf = requestAnimationFrame(glide);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      stopGlide();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [ref]);
}
