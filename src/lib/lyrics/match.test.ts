import { describe, expect, it } from "vitest";
import { hitMatches, normalizeForMatch, tokenOverlap } from "@/lib/lyrics/match";

describe("normalizeForMatch", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeForMatch("Hello, World!")).toBe("hello world");
  });

  it("drops parentheticals and featurings", () => {
    expect(normalizeForMatch("Song (Remastered) feat. Someone")).toBe("song");
    expect(normalizeForMatch("Track [Live]")).toBe("track");
  });
});

describe("tokenOverlap", () => {
  it("is 1 for identical token sets and 0 for disjoint", () => {
    expect(tokenOverlap("a b", "a b")).toBe(1);
    expect(tokenOverlap("a b", "c d")).toBe(0);
  });

  it("is measured over the smaller set", () => {
    expect(tokenOverlap("a", "a b c")).toBe(1);
  });
});

describe("hitMatches", () => {
  const norm = normalizeForMatch;

  it("accepts an exact title+artist match", () => {
    expect(
      hitMatches(norm("Bohemian Rhapsody"), norm("Queen"), norm("Bohemian Rhapsody"), norm("Queen")),
    ).toBe(true);
  });

  it("rejects a completely different song (the wrong-lyrics bug)", () => {
    expect(
      hitMatches(norm("Obscure Track"), norm("Small Artist"), norm("Blinding Lights"), norm("The Weeknd")),
    ).toBe(false);
  });

  it("rejects a title match with a mismatched artist", () => {
    expect(
      hitMatches(norm("Hello"), norm("Adele"), norm("Hello"), norm("Someone Else")),
    ).toBe(false);
  });

  it("matches title-only when the artist is unknown", () => {
    expect(hitMatches(norm("Yesterday"), "", norm("Yesterday"), norm("The Beatles"))).toBe(true);
  });

  it("tolerates featurings / parentheticals via normalization", () => {
    expect(
      hitMatches(norm("Blinding Lights"), norm("The Weeknd"), norm("Blinding Lights (Remix)"), norm("The Weeknd feat. X")),
    ).toBe(true);
  });
});

describe("traditional / simplified Chinese", () => {
  it("matches a traditional title against a simplified one", () => {
    // The real failure: YouTube Music lists this track as 逍遙仙 while
    // QQ, Kugou and NetEase all index it as 逍遥仙, so the correct hit
    // was rejected and the song reported no lyrics at all.
    expect(
      hitMatches(
        normalizeForMatch("逍遙仙"),
        normalizeForMatch("筷子兄弟"),
        normalizeForMatch("逍遥仙"),
        normalizeForMatch("筷子兄弟"),
      ),
    ).toBe(true);
  });

  it("folds traditional characters in normalizeForMatch", () => {
    expect(normalizeForMatch("逍遙仙")).toBe(normalizeForMatch("逍遥仙"));
    expect(normalizeForMatch("愛情轉移")).toBe(normalizeForMatch("爱情转移"));
  });

  it("leaves non-Chinese text untouched", () => {
    expect(normalizeForMatch("Hello World")).toBe("hello world");
  });

  it("still rejects a genuinely different song", () => {
    // Script folding must not turn the matcher into a pushover: the
    // Chinese services return same-title covers by other artists.
    expect(
      hitMatches(
        normalizeForMatch("逍遙仙"),
        normalizeForMatch("筷子兄弟"),
        normalizeForMatch("逍遥仙"),
        normalizeForMatch("MOSJIE"),
      ),
    ).toBe(false);
  });
});
