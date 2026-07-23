import { TimerIcon } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Group, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";

/**
 * Lyrics timing: a single −3.0…+3.0 s offset (0.1 s steps) that shifts
 * the lyric line selection to match the audio the user actually hears.
 * Because YTMLite plays to the car over Bluetooth, the sound reaches the
 * speakers a fraction of a second after the app's playback clock — this
 * knob compensates so the highlight lands on the line being sung. It also
 * covers any other Bluetooth speaker with a different delay. The value is
 * consumed in `lyrics-view.tsx` as `position − lyricsOffsetSec`.
 */
export function LyricsTimingTab() {
  const offset = useSettingsStore((s) => s.lyricsOffsetSec);
  const setOffset = useSettingsStore((s) => s.setLyricsOffsetSec);

  const label = `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`;

  return (
    <TabPane tightTop>
      <Group>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <TimerIcon className="size-[18px] text-muted-foreground" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[15px] font-medium leading-none">
                Lyrics timing
              </span>
              <span className="text-[13px] text-muted-foreground">
                Shift the lyrics to line up with the audio you hear over
                Bluetooth. Positive delays the lyrics to match late audio;
                negative moves them earlier.
              </span>
            </div>
            <span className="shrink-0 tabular-nums text-sm font-medium">
              {label}
            </span>
          </div>

          <div className="flex items-center gap-3 pl-12">
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              −3.0s
            </span>
            <Slider
              min={-3}
              max={3}
              step={0.1}
              value={[offset]}
              onValueChange={([v]) => setOffset(v)}
              aria-label="Lyrics timing offset in seconds"
              className="flex-1"
            />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              +3.0s
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={offset === 0}
              onClick={() => setOffset(0)}
            >
              Reset
            </Button>
          </div>
        </div>
      </Group>
    </TabPane>
  );
}
