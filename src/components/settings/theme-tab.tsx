import { useTheme } from "next-themes";
import { PaletteIcon } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";

// YTMLite offers Light / Dark only — no "system" (there is no desktop
// preference to follow on the in-car display).
const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeTab() {
  const { theme, setTheme } = useTheme();
  // Any non-light value (including a stale "system") reads as dark, so the
  // segmented control never renders with nothing selected.
  const value = theme === "light" ? "light" : "dark";
  return (
    <TabPane tightTop>
      <Group>
        <SettingRow
          icon={PaletteIcon}
          title="Theme"
          description="Choose light or dark."
          control={
            <SegmentedControl
              value={value}
              onChange={setTheme}
              options={THEME_OPTIONS}
            />
          }
        />
      </Group>
    </TabPane>
  );
}
