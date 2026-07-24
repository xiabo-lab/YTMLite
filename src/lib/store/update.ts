import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

/**
 * Where an available update sits in the download/install flow. The
 * sidebar banner and the progress toasts both read this one store, so
 * they can never disagree about what's happening.
 */
export type UpdatePhase =
  | "idle" // nothing to install
  | "available" // found, not started
  | "downloading"
  | "installing"
  | "ready" // installed, waiting for a restart
  | "error";

type State = {
  phase: UpdatePhase;
  version: string | null;
  /** 0-100 while downloading; null = size unknown (indeterminate). */
  progress: number | null;
  error: string | null;
  /**
   * The plugin's update handle. `null` in the dev preview, where the
   * flow runs on mock data with no real artifact. The installer and
   * the restart action branch on this to decide real vs simulated.
   */
  handle: Update | null;
  /**
   * True when this update installs through the Debian package path
   * (`deb_update_*` in Rust) rather than Tauri's updater plugin. Both
   * drive the same banner; only the install call differs.
   */
  viaDeb: boolean;

  setAvailable: (
    version: string,
    handle: Update | null,
    viaDeb?: boolean,
  ) => void;
  setDownloading: (progress: number | null) => void;
  setInstalling: () => void;
  setReady: () => void;
  setError: (message: string) => void;
  reset: () => void;
};

export const useUpdateStore = create<State>()((set) => ({
  phase: "idle",
  version: null,
  progress: null,
  error: null,
  handle: null,
  viaDeb: false,
  setAvailable: (version, handle, viaDeb = false) =>
    set({
      phase: "available",
      version,
      handle,
      viaDeb,
      progress: null,
      error: null,
    }),
  setDownloading: (progress) => set({ phase: "downloading", progress }),
  setInstalling: () => set({ phase: "installing", progress: 100 }),
  setReady: () => set({ phase: "ready", progress: 100 }),
  setError: (error) => set({ phase: "error", error }),
  reset: () =>
    set({
      phase: "idle",
      version: null,
      progress: null,
      error: null,
      handle: null,
      viaDeb: false,
    }),
}));
