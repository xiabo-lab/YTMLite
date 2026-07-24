import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Loader2Icon,
  Maximize2Icon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  XIcon,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { useKaraokeStore } from "@/lib/store/karaoke";
import {
  LyricsBody,
  LyricsSourceButton,
  STAGE_LEADING,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import {
  ProgressSlider,
  VolumeControl,
  formatTime,
  repeatLabel,
} from "@/components/layout/player-bar";
import { QueuePopover } from "@/components/layout/queue-panel";
import { cn } from "@/lib/utils";

// Plain-vite dev in a browser has no Tauri backend; `getCurrentWindow()`
// throws there. Same guard the title bar uses.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Control sizes scale with viewport height via clamp(min, Nvh, max). The
// minimums are the floor, not the target: this overlay is driven by a
// finger on the Pi's touch panel, so every hit target stays at or above
// ~44px even on the 440px-tall bar display, and the glyphs inside are
// sized to match rather than left at the 16px button default.
// `!` is load-bearing: the Button base style sizes bare glyphs with
// `[&_svg:not([class*='size-'])]:size-4`, which outranks a plain
// `[&_svg]` rule on specificity.
const SECONDARY_BTN =
  "size-[clamp(3.5rem,15vh,4rem)] [&_svg]:size-[clamp(1.75rem,7vh,2rem)]!";
const PLAY_BTN = "size-[clamp(4.5rem,21vh,5.5rem)]";
const PLAY_GLYPH = "size-[clamp(2.25rem,9vh,2.75rem)]";
// Wide gutters between targets: a finger that lands slightly off should
// hit nothing rather than the neighbouring button. There's horizontal
// room to spare on a 1920px-wide panel, so this costs nothing.
const BTN_GAP = "gap-[clamp(0.75rem,2.5vw,2rem)]";

// Type size for the two visible lyric lines. On the 440px-tall panel
// 15vh ≈ 66px; on a normal display it caps at 60px.
const LYRIC_FONT = "clamp(1.75rem,15vh,3.75rem)";
const LYRIC_GAP = "clamp(0.25rem,1.5vh,0.75rem)";

/** How long the tap-revealed chrome (title, artist, progress) stays up. */
const CHROME_MS = 5000;

/**
 * Full-screen "karaoke" lyrics overlay.
 *
 * Opened from the player bar (the button left of the lyrics-source mic).
 * Built for the Pi's 1920x440 touch panel, which is short enough that
 * every row has to earn its height: two big lyric lines (the one being
 * sung and the next) centered on screen, one row of finger-sized
 * transport buttons below. The track name and progress bar are hidden
 * and come back for 5s on a tap anywhere that isn't a control. No cover
 * art — this is for reading along, deliberately text-only.
 *
 * Mounted once at the app-shell root so it can cover the whole window,
 * including the custom title bar. While open it also asks the OS window
 * to go fullscreen (best-effort), so on the Pi it fills the display
 * rather than just the app window; the previous fullscreen state is
 * restored on close.
 */
export function KaraokeView() {
  const open = useKaraokeStore((s) => s.open);
  const setOpen = useKaraokeStore((s) => s.setOpen);

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Drive real OS fullscreen while open, restoring the prior state after.
  useEffect(() => {
    if (!open || !IS_TAURI) return;
    let cancelled = false;
    let prev = false;
    const win = getCurrentWindow();
    void win
      .isFullscreen()
      .then((was) => {
        prev = was;
        if (!cancelled) return win.setFullscreen(true);
      })
      .catch(() => {
        /* compositor refused fullscreen — the overlay still fills the window */
      });
    return () => {
      cancelled = true;
      // Only undo our own change; if the user was already fullscreen,
      // leave them there.
      if (!prev) void win.setFullscreen(false).catch(() => {});
    };
  }, [open]);

  if (!open) return null;
  return <KaraokeStage onClose={() => setOpen(false)} />;
}

/**
 * The player-bar button that opens the overlay. Sits immediately left of
 * the lyrics-source mic. Disabled with no track, since there'd be no
 * lyrics to show.
 */
export function KaraokeButton({ className }: { className?: string }) {
  const setOpen = useKaraokeStore((s) => s.setOpen);
  const hasTrack = usePlaybackStore((s) => s.index >= 0);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Full-screen lyrics"
          disabled={!hasTrack}
          onClick={() => setOpen(true)}
          className={className}
        >
          <Maximize2Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Full-screen lyrics</TooltipContent>
    </Tooltip>
  );
}

function KaraokeStage({ onClose }: { onClose: () => void }) {
  const { playing, status, position, duration, shuffle, repeat } =
    usePlaybackStore(
      useShallow((s) => ({
        playing: s.playing,
        status: s.status,
        position: s.position,
        duration: s.duration,
        shuffle: s.shuffle,
        repeat: s.repeat,
      })),
    );
  const track = usePlaybackStore(currentTrack);
  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);

  const [scrub, setScrub] = useState<number | null>(null);
  const lyricsState = useLyricsView(track);

  // Track title, artist and progress bar are hidden by default — on the
  // 440px-tall panel that space is worth more as lyrics and finger room.
  // A tap on empty stage brings them back for `CHROME_MS`.
  const [chrome, setChrome] = useState(false);
  const hideRef = useRef<number | null>(null);
  const scrubRef = useRef(scrub);
  scrubRef.current = scrub;

  const revealChrome = useCallback(() => {
    setChrome(true);
    if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    const tick = () => {
      // Never yank the progress bar out from under a finger that's
      // still dragging it — wait out another interval instead.
      if (scrubRef.current !== null) {
        hideRef.current = window.setTimeout(tick, CHROME_MS);
        return;
      }
      hideRef.current = null;
      setChrome(false);
    };
    hideRef.current = window.setTimeout(tick, CHROME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    };
  }, []);

  const hasTrack = !!track;
  const loading = status === "loading" && playing;
  const artist =
    track?.artists?.map((a) => a.name).join(", ") ?? track?.subtitle ?? "";

  return (
    <TooltipProvider delayDuration={600}>
      <div
        className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0a] text-foreground"
        // "Empty place" only: taps that land on a control (including a
        // lyric line, which seeks) do their own job and don't also
        // summon the chrome.
        onPointerDown={(e) => {
          const el = e.target as HTMLElement | null;
          if (el?.closest("button,[data-slot=slider],[role=slider]")) return;
          revealChrome();
        }}
      >
        {/* Track info + progress — revealed on tap, then fades out. Sits
            above the lyrics rather than displacing them, so the lyric
            block never moves. */}
        <div
          aria-hidden={!chrome}
          className={cn(
            "absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-1.5 bg-gradient-to-b from-black via-black/85 to-transparent px-[clamp(1rem,5vw,5rem)] pb-10 pt-[clamp(0.5rem,3vh,1.25rem)] transition-opacity duration-300",
            chrome ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <div className="flex w-full max-w-4xl items-baseline justify-center gap-2 pr-16">
            <span className="min-w-0 truncate font-semibold text-[clamp(1rem,3.2vh,1.5rem)]">
              {track?.title ?? "Nothing playing"}
            </span>
            {artist ? (
              <span className="min-w-0 truncate text-[clamp(0.85rem,2.4vh,1.125rem)] text-muted-foreground">
                — {artist}
              </span>
            ) : null}
          </div>
          {/* Times flank the bar instead of sitting under it: one row
              instead of two on a screen that has none to spare. The
              descendant overrides fatten the track and thumb into a
              touch-sized target. */}
          <div className="flex w-full max-w-4xl items-center gap-3 [&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-track]]:h-2">
            <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
              {formatTime(scrub ?? position)}
            </span>
            <div className="min-w-0 flex-1">
              <ProgressSlider
                position={position}
                duration={duration}
                scrub={scrub}
                setScrub={setScrub}
                seek={seek}
                disabled={!hasTrack || duration <= 0}
              />
            </div>
            <span className="w-12 shrink-0 text-sm tabular-nums text-muted-foreground">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Exit full screen"
          onClick={onClose}
          className={cn(
            SECONDARY_BTN,
            "absolute right-3 top-3 z-20 text-muted-foreground hover:text-foreground",
          )}
        >
          <XIcon />
        </Button>

        {/* Lyrics — exactly two lines: the one being sung, pinned to the
            top of the box, and the one coming next. `--lyric-font` drives
            both the type size and this box's height, so the third line is
            always clipped. */}
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          style={
            {
              "--lyric-font": LYRIC_FONT,
              "--lyric-gap": LYRIC_GAP,
            } as React.CSSProperties
          }
        >
          {/* `overflow-hidden` is what enforces the two lines: the scroll
              column inside carries a tall bottom padding (so the final
              lyric can still scroll to the top), and under border-box
              that padding floors its own height well past this box. */}
          <div
            className="w-full overflow-hidden"
            style={{
              height: `calc(2 * ${STAGE_LEADING} * var(--lyric-font) + var(--lyric-gap))`,
            }}
          >
            <LyricsBody state={lyricsState} display="stage" />
          </div>
        </div>

        {/* Transport — always visible; this is what a finger reaches for. */}
        <div className="shrink-0 px-6 pb-[clamp(0.5rem,2.5vh,1.25rem)]">
          <div className={cn("flex items-center justify-center", BTN_GAP)}>
              <LyricsSourceButton state={lyricsState} className={SECONDARY_BTN} />
              <QueuePopover className={SECONDARY_BTN} />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Shuffle"
                aria-pressed={shuffle}
                onClick={() => setShuffle(!shuffle)}
                className={cn(SECONDARY_BTN, shuffle && "text-brand")}
              >
                <ShuffleIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous"
                onClick={prev}
                disabled={!hasTrack}
                className={SECONDARY_BTN}
              >
                <SkipBackIcon className="fill-current" />
              </Button>
              <Button
                size="icon"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
                disabled={!hasTrack}
                className={cn(
                  PLAY_BTN,
                  "rounded-full bg-brand text-white hover:bg-brand/90",
                )}
              >
                {loading ? (
                  <Loader2Icon className={cn(PLAY_GLYPH, "animate-spin")} />
                ) : playing ? (
                  <PauseIcon className={cn(PLAY_GLYPH, "fill-current")} />
                ) : (
                  <PlayIcon className={cn(PLAY_GLYPH, "fill-current")} />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next"
                onClick={next}
                disabled={!hasTrack}
                className={SECONDARY_BTN}
              >
                <SkipForwardIcon className="fill-current" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={repeatLabel(repeat)}
                    aria-pressed={repeat !== "off"}
                    onClick={cycleRepeat}
                    className={cn(SECONDARY_BTN, repeat !== "off" && "text-brand")}
                  >
                    {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{repeatLabel(repeat)}</TooltipContent>
              </Tooltip>
              <VolumeControl direction="vertical" className={SECONDARY_BTN} />
          </div>
        </div>

        {/* Hairline at the screen edge: the only trace of progress left
            while the chrome is hidden, and it costs 3px. Fades out when
            the real bar comes up so the two never disagree. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/10 transition-opacity duration-300",
            chrome ? "opacity-0" : "opacity-100",
          )}
        >
          <div
            className="h-full bg-brand"
            style={{
              width: `${duration > 0 ? Math.min(100, ((scrub ?? position) / duration) * 100) : 0}%`,
            }}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
