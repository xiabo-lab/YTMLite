export type WhatsNewSection = {
  heading?: string;
  /** Bulleted list of changes. */
  items?: string[];
  /**
   * Prose message rendered as a soft note panel instead of bullets.
   * Use for a personal note from the developer rather than a change
   * list. Ignored when `items` is present.
   */
  body?: string;
  /**
   * Short call-to-action rendered as a yellow alert panel below the
   * items or body. Use for a must-read instruction, e.g. signing in
   * again after an update.
   */
  alert?: string;
};

export type WhatsNewEntry = {
  /** Semver string, e.g. "0.2.0", matched against the running app version. */
  version: string;
  /** Display date, pre-formatted so there's no locale work at runtime. */
  date: string;
  /**
   * Bundled hero image served from `/public`, e.g.
   * "/whats-new/0.2.0.jpg". Omit to fall back to the branded gradient
   * banner rendered by the dialog.
   */
  image?: string;
  sections: WhatsNewSection[];
};

/**
 * Curated release notes for the What's New dialog, newest first. The
 * dialog shows the entry whose version matches the running app (or the
 * newest one when opened manually). Add an entry here for every
 * user-facing release; keep the copy free of em/en dashes.
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: "0.1.0",
    date: "July 2026",
    sections: [
      {
        heading: "First release",
        items: [
          "A lightweight YouTube Music player and synced-lyrics display for the Raspberry Pi in-car bar screen.",
        ],
      },
    ],
  },
];

/** The entry for a specific version, if one exists. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((e) => e.version === version);
}
