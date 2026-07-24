import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, MicVocalIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Lyrics, TimedLine } from "@/lib/lyrics/types";
import {
  SOURCE_LABELS,
  SOURCE_ORDER,
  useLyricsSources,
  type LyricsSource,
} from "@/lib/lyrics/sources";
import { usePlaybackStore } from "@/lib/store/playback";
import type { QueueTrack } from "@/lib/store/playback";
import { useSettingsStore } from "@/lib/store/settings";
import { cn } from "@/lib/utils";

const PREF_KEY = "ytm:lyrics-source";

type Pref = LyricsSource | "auto";
type Availability = "lrc" | "plain" | "loading" | "none";

function loadPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    // Validate against the live source list rather than a hard-coded set,
    // so a saved preference for any source (including the Chinese ones and
    // YouTube Music, added after this was first written) round-trips
    // instead of silently resetting to "auto".
    if (v === "auto") return "auto";
    if (v && (SOURCE_ORDER as string[]).includes(v)) {
      return v as Pref;
    }
  } catch {
    /* noop */
  }
  return "auto";
}

function savePref(p: Pref) {
  try {
    localStorage.setItem(PREF_KEY, p);
  } catch {
    /* noop */
  }
}

export type LyricsViewState = {
  active: Lyrics | null;
  isLoading: boolean;
  hasTrack: boolean;
  pref: Pref;
  setPref: (p: Pref) => void;
  best: LyricsSource | null;
  availability: Record<LyricsSource, Availability>;
};

/**
 * Drives the inline lyrics panel: fires queries to all three sources,
 * tracks the user's source preference, and exposes a render-ready
 * state. Auto-pick rule: any timed source > any plain source, ordered
 * by `SOURCE_ORDER`.
 *
 * Used by the player bar to render `<LyricsBody>` (the flowing area)
 * and `<LyricsSourceButton>` (the mic-icon dropdown) from the same
 * state — without running the underlying queries twice.
 */
export function useLyricsView(track: QueueTrack | undefined): LyricsViewState {
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const setPref = (p: Pref) => {
    setPrefState(p);
    savePref(p);
  };

  const { queries, best, isLoading } = useLyricsSources(track, !!track);

  const availability = useMemo(() => {
    const acc = {} as Record<LyricsSource, Availability>;
    for (const s of SOURCE_ORDER) {
      const q = queries[s];
      acc[s] = q.data
        ? q.data.kind === "timed"
          ? "lrc"
          : "plain"
        : q.isLoading
          ? "loading"
          : "none";
    }
    return acc;
  }, [queries]);

  const activeSource: LyricsSource | null = pref === "auto" ? best : pref;
  const active = activeSource ? (queries[activeSource].data ?? null) : null;

  return {
    active,
    isLoading,
    hasTrack: !!track,
    pref,
    setPref,
    best,
    availability,
  };
}

/**
 * `panel` — the compact player-bar / popover column (default).
 * `stage` — the full-screen karaoke overlay: bigger, centered text.
 * Both share the same scroll + highlight engine below.
 */
export type LyricsDisplay = "panel" | "stage";

/** Line-height multiplier for stage text. Exported because the stage
 *  sizes its viewport to exactly two lines — `2 × font × leading + gap`
 *  — and both halves of that sum must agree. */
export const STAGE_LEADING = 1.3;

export function LyricsBody({
  state,
  display = "panel",
}: {
  state: LyricsViewState;
  display?: LyricsDisplay;
}) {
  if (!state.hasTrack) return null;
  const notice =
    display === "stage"
      ? "text-center text-2xl text-muted-foreground"
      : "px-4 py-2 text-sm text-muted-foreground";
  if (state.isLoading && !state.active) {
    return <p className={notice}>Loading lyrics…</p>;
  }
  if (!state.active) {
    return <p className={notice}>No lyrics found.</p>;
  }
  if (state.active.kind === "timed") {
    return <TimedLyrics lines={state.active.lines} display={display} />;
  }
  return <PlainLyrics text={state.active.text} display={display} />;
}

/** How long before a line's actual start time we flip it to active.
 *  At this moment the previous line's CSS transition begins fading it
 *  out and the new line's transition begins fading it in. The
 *  `duration-*` value on the line element controls how long that
 *  cross-fade takes — set a touch longer than the lookahead so the
 *  handoff feels smooth rather than crisp. */
const ACTIVE_LOOKAHEAD_S = 0.72;

function findActiveIdx(lines: TimedLine[], position: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].start - ACTIVE_LOOKAHEAD_S;
    if (start > position) break;
    const nextStart = lines[i + 1]?.start;
    const end =
      nextStart !== undefined
        ? nextStart - ACTIVE_LOOKAHEAD_S
        : (lines[i].end ?? Infinity);
    if (position < end) {
      active = i;
      break;
    }
    active = i;
  }
  return active;
}

/** How far from the top of the viewport the active line should sit,
 *  as a fraction of the visible height. 0.5 = perfectly centered;
 *  smaller pushes the active line up and reveals more upcoming text. */
const ACTIVE_LINE_VIEWPORT_RATIO = 0.36;

/** Scroll offset that puts `el` (the active line) where it belongs.
 *
 *  Panel: the active line sits above center so upcoming lines stay
 *  visible — except line 0, which is pinned to the top so the column
 *  doesn't start half-empty.
 *  Stage: the viewport is exactly two lines tall (see `KaraokeStage`),
 *  so the active line is always pinned to the top and the line below it
 *  is the one upcoming. */
function scrollTargetTop(
  container: HTMLElement,
  el: HTMLElement,
  idx: number,
  stage: boolean,
): number {
  // getBoundingClientRect avoids depending on offsetParent.
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const elTopWithinContent = eRect.top - cRect.top + container.scrollTop;
  const offset =
    stage || idx === 0
      ? 0
      : container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO -
        el.clientHeight / 2;
  return Math.max(0, elTopWithinContent - offset);
}

/** Duration of the auto-scroll that re-centers the active line.
 *  Native `scrollTo({ behavior: "smooth" })` is non-configurable in
 *  Chromium (~300 ms regardless of distance), which feels jumpy on
 *  long jumps — we drive the scroll ourselves with rAF instead. */
const SCROLL_DURATION_MS = 720;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function TimedLyrics({
  lines,
  display = "panel",
}: {
  lines: TimedLine[];
  display?: LyricsDisplay;
}) {
  const stage = display === "stage";
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const rawPosition = usePlaybackStore((s) => s.position);
  const seek = usePlaybackStore((s) => s.seek);
  // Lyrics-timing offset: the audio reaches the car speakers a moment
  // after the app's playback clock over Bluetooth, so select the lyric
  // line for `position − offset`. Positive offset holds lyrics back to
  // match late audio; negative pushes them ahead. See the Lyrics Timing
  // setting.
  const offset = useSettingsStore((s) => s.lyricsOffsetSec);
  const position = rawPosition - offset;

  const activeIdx = findActiveIdx(lines, position);
  const prevActiveRef = useRef(activeIdx);

  // On mount and whenever the lyric set changes (new track), snap the
  // active line into view without animation. Without this the animated
  // effect below never fires on mount (prevActiveRef starts equal to the
  // initial activeIdx), so opening the panel mid-song — or skipping tracks
  // while it stays mounted — leaves the active line off-screen / stale.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const idx = findActiveIdx(
      lines,
      usePlaybackStore.getState().position -
        useSettingsStore.getState().lyricsOffsetSec,
    );
    prevActiveRef.current = idx;
    if (idx < 0) {
      container.scrollTop = 0;
      return;
    }
    const el = container.querySelector<HTMLElement>(
      `[data-line-idx="${idx}"]`,
    );
    if (!el) {
      container.scrollTop = 0;
      return;
    }
    container.scrollTop = scrollTargetTop(container, el, idx, stage);
    // Re-snap when the timing offset changes so dragging the slider
    // re-aligns the active line immediately.
  }, [lines, offset, stage]);

  useEffect(() => {
    if (activeIdx === prevActiveRef.current) return;
    prevActiveRef.current = activeIdx;
    if (activeIdx < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-line-idx="${activeIdx}"]`,
    );
    if (!el) return;
    const targetTop = scrollTargetTop(container, el, activeIdx, stage);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const startTop = container.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) return;

    const startTs = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTs) / SCROLL_DURATION_MS);
      container.scrollTop = startTop + delta * easeInOutCubic(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [activeIdx, stage]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className={cn(
          "lyrics-no-scrollbar flex h-full flex-col overflow-y-auto pt-0",
          // Stage: the viewport is only two lines tall, so the bottom
          // padding has to exceed it for the final line to reach the
          // top. `--lyric-gap` is set by the stage container.
          stage
            ? "gap-[var(--lyric-gap,0.5rem)] px-8 pb-[60vh]"
            : "gap-1 px-1 pb-16",
          // Mask kicks in only after the karaoke has moved past the
          // first line — that way the first line stays crisp at the
          // top of the column while the song hasn't started or is on
          // line 0. Skipped on the stage: with two visible lines the
          // fade would eat the active line itself.
          !stage && activeIdx >= 1 && "lyrics-mask",
        )}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <button
              key={i}
              type="button"
              data-line-idx={i}
              onClick={() => seek(line.start)}
              // Stage type size comes from the container's `--lyric-font`
              // so the two-line viewport height can be derived from the
              // exact same value (see `KaraokeStage`).
              style={
                stage
                  ? { fontSize: "var(--lyric-font)", lineHeight: STAGE_LEADING }
                  : undefined
              }
              className={cn(
                // Same font-size on every line so the active line can't
                // grow into a second row and shove neighbours around.
                // The "active is bigger" feel comes from a transform
                // scale (off the layout flow) plus weight + glow.
                //
                // Cross-fade duration is a touch longer than
                // `ACTIVE_LOOKAHEAD_S` (800 ms) so the highlight is
                // well past the midpoint by the time the new line
                // actually starts, but still feels deliberate rather
                // than abrupt. ease-in-out softens both ends.
                // `scale` lives on its own CSS property in Tailwind v4
                // (not `transform`), so it's listed explicitly in the
                // transition. Both branches set a `scale-*` so the
                // browser has a defined start AND end to interpolate.
                "lyrics-line cursor-pointer rounded-md font-[650] leading-snug transition-[scale,color] duration-[1260ms] ease-in-out hover:bg-black/30",
                // Stage (full-screen karaoke): large, centered text that
                // scales from its center. No vertical padding — the
                // two-line viewport is measured from font-size × leading
                // alone. Panel: compact, left-aligned.
                stage
                  ? "origin-center px-4 py-0 text-center"
                  : "origin-left px-2 py-1 text-left text-lg",
                isActive
                  ? stage
                    ? "scale-[1.04] text-foreground"
                    : "scale-[1.06] text-foreground"
                  : isPast
                    ? "scale-100 text-muted-foreground/40"
                    : "scale-100 text-muted-foreground/70",
              )}
            >
              {line.text || "♪"}
            </button>
          );
        })}
      </div>
      {/* Static blur overlay — sits over the top of the lyrics column
          and applies `backdrop-filter` to whatever is visually behind
          it. Lines passing through the strip appear blurred, but the
          blur travels with the viewport, not the content — so when the
          user manually scrolls up to find an earlier line, that line
          becomes clear as it leaves the blurred strip.
          When the very first line is active it sits at viewport top
          (no above-center offset), so we fade the overlay out to keep
          the first line crisp.

          NOT rendered in the full-screen stage: `backdrop-filter` is by
          far the most expensive per-frame GPU op here, and blurring a
          strip across a 3440x1440 surface on the Pi's V3D makes the
          karaoke scroll visibly stutter. The panel is small enough that
          the cost is negligible, so the effect stays there. */}
      {!stage ? (
        <div
          aria-hidden
          className="lyrics-blur-overlay pointer-events-none absolute inset-x-0 top-0 h-[26%] transition-opacity duration-500 ease-in-out"
          style={{ opacity: activeIdx <= 0 ? 0 : 1 }}
        />
      ) : null}
    </div>
  );
}

function PlainLyrics({
  text,
  display = "panel",
}: {
  text: string;
  display?: LyricsDisplay;
}) {
  const stage = display === "stage";
  return (
    <div
      style={
        stage
          ? { fontSize: "var(--lyric-font)", lineHeight: STAGE_LEADING }
          : undefined
      }
      className={cn(
        "app-scroll h-full overflow-y-auto whitespace-pre-wrap pt-0 font-medium text-foreground/90",
        stage
          ? "lyrics-no-scrollbar px-8 pb-[30vh] text-center"
          : "lyrics-mask px-2 pb-12 text-lg leading-relaxed",
      )}
    >
      {text}
    </div>
  );
}

export function LyricsSourceButton({
  state,
  className,
}: {
  state: LyricsViewState;
  className?: string;
}) {
  const { pref, setPref, best, availability } = state;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Lyrics source"
              className={className}
            >
              <MicVocalIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Lyrics source</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Lyrics source</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setPref("auto")}>
          <span className="flex-1">
            Auto
            {best ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({SOURCE_LABELS[best]})
              </span>
            ) : null}
          </span>
          {pref === "auto" ? <CheckIcon className="size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SOURCE_ORDER.map((s) => {
          const a = availability[s];
          const dot =
            a === "lrc"
              ? "bg-brand"
              : a === "plain"
                ? "bg-muted-foreground/60"
                : a === "loading"
                  ? "bg-muted-foreground/30 animate-pulse"
                  : "bg-transparent";
          return (
            <DropdownMenuItem
              key={s}
              onSelect={() => setPref(s)}
              disabled={a === "none"}
            >
              <span
                className={cn("mr-2 size-1.5 shrink-0 rounded-full", dot)}
              />
              <span className="flex-1">{SOURCE_LABELS[s]}</span>
              {pref === s ? <CheckIcon className="size-4" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
