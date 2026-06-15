// Shared data-loading hook for route components. Collapses the repeated
//   const [data, setData] = useState(null);
//   const [state, setState] = useState<LoadState>("loading");
//   useEffect(() => { void fetcher().then(set+"ok").catch(set "error"); }, []);
// pattern into `const { data, state } = useApi(fetcher)`.
//
// Behavior-preserving notes:
//  - Fires the fetcher once on mount (the deps are intentionally empty, like the
//    inline effects it replaces; pass a STABLE fetcher — e.g. `api.statsSummary`
//    or a useCallback).
//  - On success: data set, state -> "ok". On rejection: state -> "error"
//    (data stays null), matching the old `.catch(() => setState("error"))`.
//  - Sets are guarded by a cancel flag so a late resolution after unmount is a
//    no-op (the old inline effects mostly lacked this; ignoring a post-unmount
//    set is strictly safer and not observable in the UI).
import { useEffect, useState } from "react";

export type LoadState = "loading" | "error" | "ok";

export interface ApiResult<T> {
  data: T | null;
  state: LoadState;
}

export function useApi<T>(fetcher: () => Promise<T>): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    void fetcher()
      .then((v) => {
        if (cancelled) return;
        setData(v);
        setState("ok");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, state };
}
