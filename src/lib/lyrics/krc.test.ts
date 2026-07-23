import { describe, it, expect } from "vitest";
import { formatLrcTimestamp, krcTextToLrc } from "@/lib/lyrics/krc";

describe("formatLrcTimestamp", () => {
  it("formats milliseconds as [mm:ss.cc]", () => {
    expect(formatLrcTimestamp(0)).toBe("[00:00.00]");
    expect(formatLrcTimestamp(1234)).toBe("[00:01.23]");
    expect(formatLrcTimestamp(61_050)).toBe("[01:01.05]");
  });

  it("keeps two-digit minutes past an hour rather than wrapping", () => {
    // LRC has no hour field; 63 minutes must stay 63, not roll to 03.
    expect(formatLrcTimestamp(63 * 60_000)).toBe("[63:00.00]");
  });
});

describe("krcTextToLrc", () => {
  it("flattens per-word runs into one line at the line start", () => {
    const krc = ["[1000,2000]<0,500,0>你好<500,500,0>世界"].join("\n");
    expect(krcTextToLrc(krc)).toBe("[00:01.00]你好世界");
  });

  it("skips metadata lines that carry no [start,duration] tag", () => {
    const krc = [
      "[ti:Some Title]",
      "[ar:Some Artist]",
      "[language:eyJ...]",
      "[500,1000]<0,500,0>hello",
    ].join("\n");
    expect(krcTextToLrc(krc)).toBe("[00:00.50]hello");
  });

  it("drops lines whose words are all blank", () => {
    // Kugou emits empty word runs for instrumental gaps; a line with no
    // text would render as a blank highlighted row.
    const krc = ["[0,100]<0,100,0>", "[1000,500]<0,500,0>real"].join("\n");
    expect(krcTextToLrc(krc)).toBe("[00:01.00]real");
  });

  it("returns null when nothing is timed", () => {
    expect(krcTextToLrc("[ti:Only metadata]")).toBeNull();
    expect(krcTextToLrc("")).toBeNull();
  });

  it("produces output parseable as ordinary LRC", () => {
    const krc = ["[0,900]<0,400,0>a<400,500,0>b", "[900,900]<0,900,0>c"].join(
      "\n",
    );
    expect(krcTextToLrc(krc)).toBe("[00:00.00]ab\n[00:00.90]c");
  });
});
