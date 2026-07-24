import { RotateCcwIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";

export function PlaybackTab() {
  const resumeOnStartup = useSettingsStore((s) => s.resumeOnStartup);
  const setResumeOnStartup = useSettingsStore((s) => s.setResumeOnStartup);

  return (
    <TabPane tightTop>
      <Group>
        <SettingRow
          icon={RotateCcwIcon}
          title="Resume on startup"
          description="When the app launches, automatically start playing the last track (from the beginning). Built for the in-car Pi, which boots straight into the app."
          control={
            <Switch
              checked={resumeOnStartup}
              onCheckedChange={setResumeOnStartup}
              aria-label="Resume playback on startup"
            />
          }
        />
      </Group>
    </TabPane>
  );
}
