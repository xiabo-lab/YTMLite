import { useEffect, useState } from "react";

/** Keep in step with the `short:` variant in index.css. */
export const SHORT_SCREEN_QUERY = "(max-height: 560px)";

/**
 * True on displays too short for a stacked hero-above-content layout —
 * the Pi's 1920x440 bar panel being the one this app targets.
 *
 * The CSS `short:` variant covers pure styling; this hook is for the
 * cases where the *structure* differs (the entity header renders as a
 * side column instead of a morphing top bar, and stops listening to
 * main's scroll position).
 */
export function useIsShortScreen(): boolean {
  const [short, setShort] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(SHORT_SCREEN_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(SHORT_SCREEN_QUERY);
    const onChange = () => setShort(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return short;
}
