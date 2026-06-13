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
