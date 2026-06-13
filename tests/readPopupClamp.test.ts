import { describe, test, expect } from "bun:test";
import { clampPopupPos } from "../web/readlayout.ts";

// clampPopupPos is pure — no DOM/React render needed.

const VW = 1000;
const VH = 800;

describe("clampPopupPos", () => {
  test("places the popup below the word when there is room", () => {
    const pos = clampPopupPos({ left: 100, top: 200, bottom: 220 }, VW, VH);
    expect(pos.y).toBe(220 + 6); // bottom + gap
    expect(pos.x).toBe(100);
  });

  test("flips above the word when a below-word popup would spill past the fold", () => {
    // word low on the page: bottom + popupH exceeds the viewport height
    const pos = clampPopupPos({ left: 100, top: 760, bottom: 780 }, VW, VH);
    expect(pos.y).toBe(760 - 6 - 260); // top - gap - popupH
  });

  test("stays below when flipping up would itself spill past the top", () => {
    // word both low AND too near the top to fit a flipped popup → stay below
    const pos = clampPopupPos({ left: 0, top: 100, bottom: 790 }, VW, 800, 340, 260);
    expect(pos.y).toBe(790 + 6);
  });

  test("clamps x within the right edge", () => {
    const pos = clampPopupPos({ left: 980, top: 100, bottom: 120 }, VW, VH);
    expect(pos.x).toBe(VW - 340);
  });

  test("clamps x to a small left margin", () => {
    const pos = clampPopupPos({ left: -50, top: 100, bottom: 120 }, VW, VH);
    expect(pos.x).toBe(8);
  });
});
