// Mobile bottom navigation (shown only at narrow widths via CSS — see the
// "mobile / responsive (appended)" section of web/styles.css). The desktop
// left sidebar stays mounted and unchanged; this is an additive overlay so the
// two never conflict (only one is ever visible at a given width).
//
// Primary tabs: View (player/home), Library, Review, Settings.
// Every OTHER route (Home, Cards, Search, Stats, Health) lives behind a "More"
// overflow drawer rendered by this component itself — deliberately NOT routed
// through SettingsRoute.tsx, which is owned by another stream.

import { useEffect, useState } from "react";
import {
  CardsIcon,
  HealthIcon,
  HomeIcon,
  LibraryIcon,
  ReviewIcon,
  SearchIcon,
  SettingsIcon,
  StatsIcon,
  ViewIcon,
} from "./icons.tsx";

interface MobileNavProps {
  routeName: string;
  go: (hash: string) => void;
  // Hash for the "View" tab: last-played episode, or library if none yet.
  viewHash: string;
  viewDisabled: boolean;
}

interface Item {
  label: string;
  icon: React.ReactNode;
  hash: string;
  // route.name(s) that mark this item active
  match: string[];
  disabled?: boolean;
}

export function MobileNav({ routeName, go, viewHash, viewDisabled }: MobileNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the overflow drawer whenever the route changes (e.g. after a tap).
  useEffect(() => {
    setMoreOpen(false);
  }, [routeName]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  const primary: Item[] = [
    { label: "View", icon: <ViewIcon />, hash: viewHash, match: ["player"], disabled: viewDisabled },
    { label: "Library", icon: <LibraryIcon />, hash: "#/", match: ["library"] },
    { label: "Review", icon: <ReviewIcon />, hash: "#/review", match: ["review"] },
    { label: "Settings", icon: <SettingsIcon />, hash: "#/settings", match: ["settings"] },
  ];

  // Secondary destinations surfaced via the "More" drawer.
  const secondary: Item[] = [
    { label: "Home", icon: <HomeIcon />, hash: "#/home", match: ["home"] },
    { label: "Cards", icon: <CardsIcon />, hash: "#/cards", match: ["cards"] },
    { label: "Search", icon: <SearchIcon />, hash: "#/search", match: ["search"] },
    { label: "Stats", icon: <StatsIcon />, hash: "#/stats", match: ["stats"] },
    { label: "Health", icon: <HealthIcon />, hash: "#/health", match: ["health"] },
  ];

  // "More" reads active when the current route is one of the secondary ones.
  const moreActive = secondary.some((it) => it.match.includes(routeName));

  const tab = (it: Item) => {
    const active = it.match.includes(routeName);
    return (
      <button
        key={it.label}
        className={`mnav-item${active ? " active" : ""}`}
        disabled={it.disabled}
        aria-label={it.label}
        aria-current={active ? "page" : undefined}
        onClick={() => go(it.hash)}
      >
        <span className="mnav-icon" aria-hidden>{it.icon}</span>
        <span className="mnav-label">{it.label}</span>
      </button>
    );
  };

  return (
    <>
      {moreOpen && (
        <div
          className="mnav-drawer-backdrop"
          aria-hidden
          onClick={() => setMoreOpen(false)}
        />
      )}
      <div
        className={`mnav-drawer${moreOpen ? " open" : ""}`}
        role="menu"
        aria-label="More destinations"
        aria-hidden={!moreOpen}
      >
        {secondary.map((it) => {
          const active = it.match.includes(routeName);
          return (
            <button
              key={it.label}
              className={`mnav-drawer-item${active ? " active" : ""}`}
              role="menuitem"
              tabIndex={moreOpen ? 0 : -1}
              aria-current={active ? "page" : undefined}
              onClick={() => go(it.hash)}
            >
              <span className="mnav-icon" aria-hidden>{it.icon}</span>
              <span>{it.label}</span>
            </button>
          );
        })}
      </div>

      <nav className="mnav" aria-label="Primary">
        {primary.map(tab)}
        <button
          className={`mnav-item mnav-more${moreActive || moreOpen ? " active" : ""}`}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <span className="mnav-icon" aria-hidden>
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="5" cy="12" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
            </svg>
          </span>
          <span className="mnav-label">More</span>
        </button>
      </nav>
    </>
  );
}
