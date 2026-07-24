import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  DownloadIcon,
  InfoIcon,
  PowerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openSettings } from "@/lib/store/settings-dialog";
import { checkForUpdates } from "@/lib/updater";
import { AboutDialog } from "@/components/layout/about-dialog";

// Caption-bar nav buttons get just an icon-color shift on hover —
// the default ghost-button square highlight competes visually with
// the Windows-style min/max/close cells on the right side of the bar.
const NAV_BTN_CLS =
  "size-7 text-foreground/65 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent";

// Plain-vite dev in a regular browser has no Tauri backend —
// `getCurrentWindow()` throws on missing `__TAURI_INTERNALS__`, which
// used to crash the whole shell through the router's error boundary.
// Window controls are meaningless in a browser tab anyway.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Custom title bar. The native window frame is disabled
 * (`decorations: false` in tauri.conf.json) so we draw the strip
 * ourselves: navigation controls centered, Windows-style
 * min/maximize/close on the right, drag region everywhere else.
 *
 * The nav cluster is centered rather than tucked in the left corner,
 * and widely spaced, because this is reached by finger on the Pi's
 * panel — the corner is the worst place on the screen to hit, and
 * four 28px targets a few px apart is a coin toss.
 *
 * Clicking our close button still goes through the Rust
 * `WindowEvent::CloseRequested` handler, which either hides the window
 * into the tray (default) or quits, per the "Close button" choice on
 * the Settings page. The "Quit" item in the More menu always
 * terminates the process regardless of that setting.
 */
export function TopBar() {
  const router = useRouter();
  const [maximized, setMaximized] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });
    // Mirrors the cancelled-flag pattern used in audio-engine / app-shell:
    // `.onResized` is async, so its `.then` may resolve AFTER cleanup ran
    // in StrictMode's mount → unmount → remount cycle. Without the flag the
    // listener leaks twice and we get duplicated maximized-state updates.
    win
      .onResized(() => {
        win.isMaximized().then((m) => {
          if (!cancelled) setMaximized(m);
        });
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = () => getCurrentWindow();

  return (
    <>
      <header
        data-tauri-drag-region
        className="relative z-30 flex h-9 shrink-0 select-none items-center"
      >
        {/* Absolutely centered on the window, so the cluster sits in the
            middle regardless of how wide the caption buttons are. */}
        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-24">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={NAV_BTN_CLS}
                aria-label="More"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={() => openSettings()}>
                <SettingsIcon />
                Settings
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={() => {
                  void checkForUpdates({ silent: false });
                }}
              >
                <DownloadIcon />
                Check for Updates
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
                <InfoIcon />
                About
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={() => {
                  void invoke("quit_app");
                }}
              >
                <PowerIcon />
                Quit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <SidebarTrigger className={NAV_BTN_CLS} />
          <Button
            variant="ghost"
            size="icon"
            className={NAV_BTN_CLS}
            onClick={() => router.history.back()}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={NAV_BTN_CLS}
            onClick={() => router.history.forward()}
            aria-label="Forward"
          >
            <ArrowRightIcon />
          </Button>
        </div>

        {/* Drag spacer — fills everything left of the caption buttons so
            the user can grab almost anywhere in the bar to move the
            window. The nav cluster floats above it. */}
        <div data-tauri-drag-region className="h-full flex-1" />

        <div className="flex h-full items-center">
          <button
            type="button"
            onClick={() => win().minimize()}
            aria-label="Minimize"
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-titlebar-hover"
          >
            <MinimizeGlyph />
          </button>
          <button
            type="button"
            onClick={() => win().toggleMaximize()}
            aria-label={maximized ? "Restore" : "Maximize"}
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-titlebar-hover"
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </button>
          <button
            type="button"
            onClick={() => win().close()}
            aria-label="Close"
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-[#c42b1c] hover:text-white"
          >
            <CloseGlyph />
          </button>
        </div>
      </header>

      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  );
}

/* Hand-drawn 10×10 SVGs match the Windows 11 caption-button glyphs
   more faithfully than Lucide icons (which are designed at 24px and
   look chunky at this size). */

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function RestoreGlyph() {
  // Front square is a full outlined rect; back square is drawn as an
  // L-shape (top + right edge only) so we don't have to fill the
  // front rect with the background color — important here because
  // the title bar is transparent over the blurred album art behind.
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path
        d="M2.5 0.5 H9.5 V7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="0.5"
        y="2.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path
        d="M0 0 L10 10 M10 0 L0 10"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
