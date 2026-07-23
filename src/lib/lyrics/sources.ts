import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import { fetchMusixmatchLyrics } from "@/lib/lyrics/musixmatch";
import { fetchGeniusLyrics } from "@/lib/lyrics/genius";
import { fetchQqLyrics } from "@/lib/lyrics/qq";
import { fetchKugouLyrics } from "@/lib/lyrics/kugou";
import { fetchNeteaseLyrics } from "@/lib/lyrics/netease";
import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import type { Lyrics } from "@/lib/lyrics/types";
import type { QueueTrack } from "@/lib/store/playback";

export type LyricsSource =
  | "ytmusic"
  | "kugou"
  | "lrclib"
  | "netease"
  | "musixmatch"
  | "qq"
  | "genius";

/**
 * Auto-pick preference order.
 *
 * YouTube Music leads because it is the only source that needs no
 * matching step: its lyrics are addressed by the exact videoId being
 * played, so it can never return a different song. Everything after it
 * has to search and then guess.
 *
 * The rest lead with the Chinese services because LRCLIB, Musixmatch
 * and Genius cover Mandarin and Cantonese catalogues poorly. Ordering
 * them ahead of the western ones is safe because every searching source
 * verifies its hit against the requested title/artist (`hitMatches`)
 * and returns null rather than a confidently-wrong different song, so a
 * track they don't carry simply falls through.
 *
 * Note this is a *preference* order, not a strict one: a source earlier
 * in the list only wins over a later one at the same quality level. See
 * the two-pass selection at the bottom of `useLyricsSources` — synced
 * lyrics from any source beat plain lyrics from any other, because the
 * player's whole lyrics view is built around line highlighting.
 */
export const SOURCE_ORDER: LyricsSource[] = [
  "ytmusic",
  "kugou",
  "lrclib",
  "netease",
  "musixmatch",
  "qq",
  "genius",
];

export const SOURCE_LABELS: Record<LyricsSource, string> = {
  ytmusic: "YouTube Music",
  qq: "QQ Music",
  kugou: "Kugou",
  netease: "NetEase",
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch",
  genius: "Genius",
};

const ONE_HOUR = 60 * 60 * 1000;

/**
 * Fire every lyric query in parallel, plus a derived "best" selection.
 * Auto-pick rule: first source (in `SOURCE_ORDER`) that has any lyrics,
 * with timed lyrics ALWAYS winning over plain — i.e. if LRCLIB has plain
 * text but QQ has synced LRC, QQ wins.
 */
export function useLyricsSources(track: QueueTrack | undefined, enabled: boolean) {
  const artistName =
    track?.artists?.map((a) => a.name).join(", ") ?? track?.subtitle;

  const ytmusic = useQuery({
    queryKey: ["lyrics", "ytmusic", track?.videoId],
    queryFn: () => fetchYtMusicLyrics(track!.videoId),
    enabled: !!track?.videoId && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const qq = useQuery({
    queryKey: ["lyrics", "qq", track?.title, artistName],
    queryFn: () => fetchQqLyrics({ title: track!.title, artist: artistName }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const kugou = useQuery({
    queryKey: ["lyrics", "kugou", track?.title, artistName],
    queryFn: () => fetchKugouLyrics({ title: track!.title, artist: artistName }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const netease = useQuery({
    queryKey: ["lyrics", "netease", track?.title, artistName],
    queryFn: () =>
      fetchNeteaseLyrics({ title: track!.title, artist: artistName }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const lrclib = useQuery({
    queryKey: [
      "lyrics",
      "lrclib",
      track?.title,
      artistName,
      track?.album,
      track?.duration,
    ],
    queryFn: () =>
      fetchLrclibLyrics({
        title: track!.title,
        artist: artistName,
        album: track?.album,
        duration: track?.duration,
      }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const musixmatch = useQuery({
    queryKey: ["lyrics", "musixmatch", track?.title, artistName],
    queryFn: () =>
      fetchMusixmatchLyrics({
        title: track!.title,
        artist: artistName,
      }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const genius = useQuery({
    queryKey: ["lyrics", "genius", track?.title, artistName],
    queryFn: () =>
      fetchGeniusLyrics({
        title: track!.title,
        artist: artistName,
      }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const queries: Record<LyricsSource, UseQueryResult<Lyrics | null>> = {
    ytmusic,
    qq,
    kugou,
    netease,
    lrclib,
    musixmatch,
    genius,
  };

  let best: LyricsSource | null = null;
  for (const s of SOURCE_ORDER) {
    if (queries[s].data?.kind === "timed") {
      best = s;
      break;
    }
  }
  if (!best) {
    for (const s of SOURCE_ORDER) {
      if (queries[s].data?.kind === "plain") {
        best = s;
        break;
      }
    }
  }

  const isLoading = SOURCE_ORDER.some((s) => queries[s].isLoading);

  return { queries, best, isLoading };
}
