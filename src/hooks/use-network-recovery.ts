import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** How often to re-attempt failed queries while something is broken. */
const RETRY_INTERVAL_MS = 4000;

/**
 * Self-heals the app when the network arrives *after* launch.
 *
 * On the in-car Pi the app boots the instant the car powers on, often
 * before Wi-Fi has associated. Every network query fired at that moment
 * fails — the home feed, `account-info` and `premium-status` (both
 * `retry: false`, so they give up after one try), the library, etc. —
 * and the sidebar falls back to "Sign in" even though the cookies are
 * still on disk. React Query's built-in reconnect refetch keys off
 * `navigator.onLine` / the `online` event, which WebKitGTK on the Pi
 * doesn't fire reliably, so nothing re-runs and the user has to quit and
 * relaunch (by which time Wi-Fi is up).
 *
 * This watcher closes that gap: every few seconds it refetches any
 * *mounted* query that's currently in an error state. While offline they
 * just fail fast again; once the connection is back they succeed and
 * stop erroring, so the loop naturally goes quiet — a healthy session
 * has no errored active queries and this does nothing. It also handles
 * the reverse case, Wi-Fi dropping and returning mid-drive.
 */
export function useNetworkRecovery(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const refetchErrored = () => {
      const errored = qc
        .getQueryCache()
        .getAll()
        .filter(
          (q) => q.getObserversCount() > 0 && q.state.status === "error",
        );
      for (const q of errored) {
        void qc.invalidateQueries({ queryKey: q.queryKey });
      }
    };
    const id = window.setInterval(refetchErrored, RETRY_INTERVAL_MS);
    // If the webview ever does surface an online event, act on it at once
    // rather than waiting out the interval.
    const onOnline = () => refetchErrored();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, [qc]);
}
