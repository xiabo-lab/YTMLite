import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutMode = "right" | "bottom" | "floating";

type State = {
  mode: LayoutMode;
  /** Always-on-top toggle for the floating-player window. Persisted
   *  so a pinned window stays pinned after a close/reopen cycle. */
  floatingPinned: boolean;
  setMode: (mode: LayoutMode) => void;
  setFloatingPinned: (v: boolean) => void;
};

/**
 * Player layout. YTMLite is **bottom-bar only** — the Side Card and
 * Floating Window modes were removed for the 1920×440 in-car screen.
 * `LayoutMode` keeps all three variants so shared code that still
 * branches on mode type-checks, but `mode` is pinned to `bottom`:
 * `setMode` is a no-op and any stale persisted value is coerced on
 * rehydrate via `merge`.
 */
export const useLayoutStore = create<State>()(
  persist(
    (set) => ({
      mode: "bottom",
      floatingPinned: false,
      setMode: () => set({ mode: "bottom" }),
      setFloatingPinned: (floatingPinned) => set({ floatingPinned }),
    }),
    {
      name: "ytm-layout",
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<State>),
        mode: "bottom",
      }),
    },
  ),
);

// The main and floating-player windows are separate JS contexts that share
// the `ytm-layout` localStorage key. Without cross-window sync, a change in
// one (e.g. the floating window toggling `floatingPinned`) is invisible to
// the other, whose next `setMode` then clobbers it with a stale value. The
// `storage` event fires in the OTHER window on write, so re-hydrate from it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-layout") {
      void useLayoutStore.persist.rehydrate();
    }
  });
}
