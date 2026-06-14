import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  type LibraryEntry,
} from "./api.ts";
import { Player } from "./Player.tsx";
import { ReadRoute } from "./ReadRoute.tsx";
import { HealthRoute } from "./HealthRoute.tsx";
import { Cards } from "./CardsRoute.tsx";
import { Home } from "./HomeRoute.tsx";
import { Library } from "./LibraryRoute.tsx";
import { Stats } from "./StatsRoute.tsx";
import { Search } from "./SearchRoute.tsx";
import { Review } from "./ReviewRoute.tsx";
import { Settings } from "./SettingsRoute.tsx";
import { Palette } from "./Palette.tsx";
import { startSync } from "./sync.ts";
import { tmEvent, tmStart } from "./telemetry.ts";
import {
  CardsIcon,
  HealthIcon,
  HomeIcon,
  LibraryIcon,
  SettingsIcon,
  StatsIcon,
  ReviewIcon,
  SearchIcon,
  ViewIcon,
} from "./icons.tsx";

type Route =
  | { name: "library" }
  | { name: "player"; id: string; t?: number }
  | { name: "read"; id: string }
  | { name: "settings" }
  | { name: "stats" }
  | { name: "search" }
  | { name: "cards" }
  | { name: "review" }
  | { name: "home" }
  | { name: "health" };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("play/")) {
    // "#/play/<id>" or "#/play/<id>@123.4" (seek after load)
    const rest = h.slice("play/".length);
    const at = rest.indexOf("@");
    const id = at >= 0 ? rest.slice(0, at) : rest;
    const t = at >= 0 ? parseFloat(rest.slice(at + 1)) : NaN;
    return { name: "player", id, ...(Number.isFinite(t) && t >= 0 ? { t } : {}) };
  }
  if (h.startsWith("read/")) return { name: "read", id: h.slice("read/".length) };
  if (h === "settings") return { name: "settings" };
  if (h === "stats") return { name: "stats" };
  if (h === "search") return { name: "search" };
  if (h === "cards") return { name: "cards" };
  if (h === "review") return { name: "review" };
  if (h === "home") return { name: "home" };
  if (h === "health") return { name: "health" };
  return { name: "library" };
}

const LAST_MEDIA_KEY = "zr.lastMedia";

function readLastMedia(): string | null {
  try {
    return localStorage.getItem(LAST_MEDIA_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        setSettings(s);
        // apply the persisted theme once on load, and mirror it to
        // localStorage so index.html's bootstrap avoids a flash next time.
        const theme = (s.theme as string) || "light";
        document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem("zr.theme", theme);
        } catch {
          /* ignore storage errors */
        }
      })
      .catch(() => {});
    tmStart();
  }, []);

  // zr.* localStorage <-> server state sync (web/sync.ts contract): pull on
  // start, then push changed keys debounced. Once per app lifetime.
  useEffect(() => {
    const handle = startSync();
    return () => handle.stop();
  }, []);

  // Telemetry: one route_change event per navigation.
  useEffect(() => {
    tmEvent("route_change", {
      route: route.name,
      ...(route.name === "player" ? { mediaId: route.id } : {}),
    });
  }, [route]);

  // "View" nav target: the current/last-played episode.
  const lastMedia =
    route.name === "player" ? route.id : readLastMedia();

  // Keep the pending hide-timer so a second toast isn't cleared early by the
  // first toast's timeout.
  const toastTimer = useRef<number | null>(null);
  const toast = useCallback((msg: string) => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    setToastMsg(msg);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToastMsg(null);
    }, 2600);
  }, []);

  // Toasts must render inside the fullscreened element, otherwise they're
  // invisible (the top-layer fullscreen element covers body-level nodes).
  const [fsEl, setFsEl] = useState<Element | null>(null);
  useEffect(() => {
    const sync = () => setFsEl(document.fullscreenElement);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  // Current theme + shared setter, reused by the sidebar switcher and the
  // Settings <select> (both stay in sync via the shared `settings` state).
  const theme = (settings.theme as string) || "light";
  const applyTheme = (value: string) => {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("zr.theme", value);
    } catch {
      /* ignore storage errors */
    }
    setSettings((s) => ({ ...s, theme: value }));
    void api.saveSettings({ theme: value }).catch(() => {});
  };

  const navItem = (
    label: string,
    icon: React.ReactNode,
    hash: string,
    active: boolean,
    disabled = false,
  ) => (
    <button
      className={`side-item${active ? " active" : ""}`}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={() => go(hash)}
    >
      <span className="side-icon" aria-hidden>{icon}</span>
      <span className="side-label">{label}</span>
    </button>
  );

  return (
    <div className="app shell">
      <aside className="sidebar">
        <a className="brand side-brand" href="#/home" title="Home">
          <span className="side-icon brand-mark" aria-hidden>十日</span>
          <span className="side-label">zehntage</span>
        </a>
        <nav className="side-nav">
          {navItem("Home", <HomeIcon />, "#/home", route.name === "home")}
          {navItem("Library", <LibraryIcon />, "#/", route.name === "library")}
          {navItem(
            "View",
            <ViewIcon />,
            lastMedia ? `#/play/${lastMedia}` : "#/",
            route.name === "player",
            !lastMedia,
          )}
          {navItem("Cards", <CardsIcon />, "#/cards", route.name === "cards")}
          {navItem("Review", <ReviewIcon />, "#/review", route.name === "review")}
          {navItem("Search", <SearchIcon />, "#/search", route.name === "search")}
          {navItem("Stats", <StatsIcon />, "#/stats", route.name === "stats")}
          {navItem("Settings", <SettingsIcon />, "#/settings", route.name === "settings")}
          {navItem("Health", <HealthIcon />, "#/health", route.name === "health")}
        </nav>
        <div className="side-theme" role="group" aria-label="Theme">
          <button
            className="theme-opt"
            data-active={theme === "light"}
            title="Light theme"
            aria-label="Light theme"
            aria-pressed={theme === "light"}
            onClick={() => applyTheme("light")}
          >
            日
          </button>
          <button
            className="theme-opt"
            data-active={theme === "dark"}
            title="Dark theme"
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            onClick={() => applyTheme("dark")}
          >
            月
          </button>
          <button
            className="theme-opt"
            data-active={theme === "system"}
            title="Follow system theme"
            aria-label="System theme"
            aria-pressed={theme === "system"}
            onClick={() => applyTheme("system")}
          >
            ◐
          </button>
        </div>
      </aside>

      <main className="container">
        {route.name === "home" && <Home go={go} />}
        {route.name === "library" && <Library go={go} toast={toast} />}
        {route.name === "stats" && <Stats go={go} />}
        {route.name === "search" && <Search go={go} />}
        {route.name === "cards" && <Cards go={go} toast={toast} />}
        {route.name === "review" && <Review go={go} toast={toast} />}
        {route.name === "health" && <HealthRoute />}
        {route.name === "settings" && (
          <Settings settings={settings} setSettings={setSettings} toast={toast} />
        )}
        {route.name === "read" && (
          <ReadRoute key={route.id} id={route.id} settings={settings} />
        )}
        {route.name === "player" && (
          <PlayerRoute
            id={route.id}
            startAt={route.t}
            toast={toast}
            settings={settings}
            go={go}
          />
        )}
      </main>

      {toastMsg &&
        (fsEl
          ? createPortal(
              <div className="toast" role="status" aria-live="polite">
                {toastMsg}
              </div>,
              fsEl,
            )
          : (
            <div className="toast" role="status" aria-live="polite">
              {toastMsg}
            </div>
          ))}
      <Palette go={go} toast={toast} settings={settings} setSettings={setSettings} />
    </div>
  );
}

export function fmtCueTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function PlayerRoute({
  id,
  startAt,
  toast,
  settings,
  go,
}: {
  id: string;
  startAt?: number;
  toast: (m: string) => void;
  settings: Record<string, unknown>;
  go: (h: string) => void;
}) {
  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Remember the last-played episode for the sidebar "View" item.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_MEDIA_KEY, id);
    } catch {
      /* private mode */
    }
  }, [id]);

  useEffect(() => {
    void api
      .library()
      .then((lib) => {
        const e = lib.find((x) => x.id === id);
        if (e) setEntry(e);
        else setNotFound(true);
      })
      .catch(() => setNotFound(true));
  }, [id]);

  if (notFound)
    return (
      <div className="empty">
        File not found.{" "}
        <button className="btn sm" onClick={() => go("#/")}>
          Back to library
        </button>
      </div>
    );
  if (!entry)
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden /> Loading…
      </div>
    );

  return (
    <>
      <Player
        key={entry.id}
        entry={entry}
        startAt={startAt}
        toast={toast}
        settings={settings}
      />
    </>
  );
}
