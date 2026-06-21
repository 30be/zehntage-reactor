import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { migrateVocabState } from "./vocabreset.ts";
import "./styles.css";

// One-time clean reset of zr.known / zr.blacklist when the vocab-key format
// changed (homograph-aware keying). Runs before first render.
migrateVocabState();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// PWA: register the app-shell service worker. Guarded so it only runs in a
// production bundle served over http(s) (not the dev server / file://), and
// failures are swallowed — the app must work even when SW registration fails.
if (
  process.env.NODE_ENV === "production" &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  /^https?:$/.test(window.location.protocol)
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is best-effort */
    });
  });
}
