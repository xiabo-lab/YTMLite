import {
  useQueries,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
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

type LyricsQueryConfig = {
  source: LyricsSource;
  queryKey: unknown[];
  queryFn: () => Promise<Lyrics | null>;
  /** ytmusic is addressed by videoId, so it can't run without one. */
  ready: boolean;
};

/**
 * The exact query key + fetcher for every source, for one track. The
 * single source of truth shared by the live hook (`useLyricsSources`)
 * and the background prefetch (`prefetchLyrics`) — they MUST agree on
 * keys byte-for-byte or the prefetch warms a cache entry the hook never
 * reads. Ordered by `SOURCE_ORDER`.
 */
function lyricsQueryConfigs(track: QueueTrack): LyricsQueryConfig[] {
  const artist = track.artists?.map((a) => a.name).join(", ") ?? track.subtitle;
  return [
    {
      source: "ytmusic",
      queryKey: ["lyrics", "ytmusic", track.videoId],
      queryFn: () => fetchYtMusicLyrics(track.videoId),
      ready: !!track.videoId,
    },
    {
      source: "kugou",
      queryKey: ["lyrics", "kugou", track.title, artist],
      queryFn: () => fetchKugouLyrics({ title: track.title, artist }),
      ready: true,
    },
    {
      source: "lrclib",
      queryKey: [
        "lyrics",
        "lrclib",
        track.title,
        artist,
        track.album,
        track.duration,
      ],
      queryFn: () =>
        fetchLrclibLyrics({
          title: track.title,
          artist,
          album: track.album,
          duration: track.duration,
        }),
      ready: true,
    },
    {
      source: "netease",
      queryKey: ["lyrics", "netease", track.title, artist],
      queryFn: () => fetchNeteaseLyrics({ title: track.title, artist }),
      ready: true,
    },
    {
      source: "musixmatch",
      queryKey: ["lyrics", "musixmatch", track.title, artist],
      queryFn: () => fetchMusixmatchLyrics({ title: track.title, artist }),
      ready: true,
    },
    {
      source: "qq",
      queryKey: ["lyrics", "qq", track.title, artist],
      queryFn: () => fetchQqLyrics({ title: track.title, artist }),
      ready: true,
    },
    {
      source: "genius",
      queryKey: ["lyrics", "genius", track.title, artist],
      queryFn: () => fetchGeniusLyrics({ title: track.title, artist }),
      ready: true,
    },
  ];
}

// Placeholder configs used when no track is loaded. Its query keys can
// never collide with a real track's (empty videoId / title), and every
// query built from it is disabled, so it exists only to keep the query
// count stable. The cast is safe: the fetchers are never called (they
// run only when enabled) and the key-builder reads fields that are all
// present-or-undefined on this object.
const EMPTY_CONFIGS = lyricsQueryConfigs({
  videoId: "",
  title: "",
} as QueueTrack);

/**
 * Warm every source's cache for `track` in the background, so switching
 * to it later shows lyrics with no fetch wait. Fire-and-forget: a source
 * with no match just caches `null`, which the hook reads as "none".
 * Uses the same keys/staleTime as the hook, so an entry warmed here is a
 * cache HIT when the hook mounts for this track.
 */
export function prefetchLyrics(client: QueryClient, track: QueueTrack): void {
  for (const c of lyricsQueryConfigs(track)) {
    if (!c.ready) continue;
    void client.prefetchQuery({
      queryKey: c.queryKey,
      queryFn: c.queryFn,
      staleTime: ONE_HOUR,
      retry: 1,
    });
  }
}

/**
 * Fire every lyric query in parallel, plus a derived "best" selection.
 * Auto-pick rule: first source (in `SOURCE_ORDER`) that has any lyrics,
 * with timed lyrics ALWAYS winning over plain — i.e. if LRCLIB has plain
 * text but QQ has synced LRC, QQ wins.
 */
export function useLyricsSources(track: QueueTrack | undefined, enabled: boolean) {
  // A stable empty track keeps the config list — and therefore the
  // number of queries handed to useQueries — the same shape whether or
  // not a track is loaded. Every query is disabled while there's no
  // real track, so nothing actually fetches.
  const configs = track ? lyricsQueryConfigs(track) : EMPTY_CONFIGS;

  const results = useQueries({
    queries: configs.map((c) => ({
      queryKey: c.queryKey,
      queryFn: c.queryFn,
      enabled: enabled && !!track && c.ready,
      staleTime: ONE_HOUR,
      retry: 1,
    })),
  }) as UseQueryResult<Lyrics | null>[];

  const queries = {} as Record<LyricsSource, UseQueryResult<Lyrics | null>>;
  configs.forEach((c, i) => {
    queries[c.source] = results[i];
  });

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
