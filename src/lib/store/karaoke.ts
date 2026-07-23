import { create } from "zustand";

/**
 * Whether the full-screen karaoke lyrics overlay is showing. Ephemeral
 * UI state (not persisted): opening the app never starts in karaoke
 * mode. Lives in a store rather than local state because the trigger
 * (a button in the player bar) and the overlay itself (mounted once at
 * the app-shell root, so it can cover the whole window) are far apart in
 * the tree.
 */
type KaraokeState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export const useKaraokeStore = create<KaraokeState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
