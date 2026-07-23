import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Mirror of `platform::Caps` in src-tauri/src/platform.rs. Every `false`
 * here is a real gap in the current build, not a preference — the UI
 * hides the corresponding affordance rather than offering something that
 * silently misbehaves. See docs/raspberry-pi.md for the why of each.
 */
export type PlatformCaps = {
  os: "windows" | "linux" | "macos" | "unknown";
  /** Can the user hold more than one signed-in Google account? */
  multiAccount: boolean;
  /** Can the app download and install its own updates? */
  inAppUpdates: boolean;
  /** Does left-clicking the tray icon raise the window? */
  trayLeftClick: boolean;
  /** Display name of the OS media-control integration. */
  mediaControls: string;
};

/**
 * Best guess before Rust answers, so the first paint doesn't flash
 * affordances we're about to hide. The webview's UA is the only
 * synchronous platform signal available, and it's reliable enough for
 * the one bit that changes layout (Linux vs not) — Rust corrects it a
 * few milliseconds later either way.
 */
function guessFromUserAgent(): PlatformCaps {
  const ua = navigator.userAgent;
  // Note: the login/session-keeper webviews present a *spoofed* Windows
  // UA to Google, but this runs in the app webview, which doesn't.
  const linux = /Linux|X11/.test(ua) && !/Android/.test(ua);
  return {
    os: linux ? "linux" : "windows",
    multiAccount: !linux,
    inAppUpdates: !linux,
    trayLeftClick: !linux,
    mediaControls: linux ? "MPRIS" : "Windows SMTC",
  };
}

type CapsState = { caps: PlatformCaps; loaded: boolean };

const useCapsStore = create<CapsState>()(() => ({
  caps: guessFromUserAgent(),
  loaded: false,
}));

/**
 * Read the capabilities. Safe to call from anywhere, including outside
 * React (the updater's startup check does).
 */
export function platformCaps(): PlatformCaps {
  return useCapsStore.getState().caps;
}

/** Reactive form of {@link platformCaps} for components. */
export function usePlatformCaps(): PlatformCaps {
  return useCapsStore((s) => s.caps);
}

/**
 * Mount once at the app root, before anything reads the caps for a
 * decision that's expensive to reverse. Capabilities are fixed for the
 * lifetime of the build, so this runs exactly once and never refetches.
 */
export function usePlatformCapsSync(): void {
  useEffect(() => {
    if (useCapsStore.getState().loaded) return;
    void invoke<PlatformCaps>("platform_caps")
      .then((caps) => useCapsStore.setState({ caps, loaded: true }))
      .catch((e) => {
        // Keep the UA guess. Worst case a capability is misreported and
        // the Rust-side guard rejects the call with a clear message.
        console.warn("[platform] platform_caps failed:", e);
      });
  }, []);
}
