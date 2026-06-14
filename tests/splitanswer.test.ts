// Unit tests for splitAnswerHtml — the pure function that splits a sanitized
// Anki answer HTML into a main (left) column and a trailing CONTEXT (right)
// column for two-column review layout.
//
// The function needs a real DOM (it uses document.createElement("template")).
// We follow the jsdom setup pattern from tests/ankihtml.test.ts exactly.

// @ts-ignore — runtime-only import, typed locally below.
import { JSDOM as JSDOMRuntime } from "jsdom";
// deno-lint-ignore no-explicit-any
const JSDOM = JSDOMRuntime as new (html: string) => { window: any };

const dom = new JSDOM("");
// deno-lint-ignore no-explicit-any
(globalThis as any).window = dom.window;
// deno-lint-ignore no-explicit-any
(globalThis as any).document = dom.window.document;

import { describe, expect, test } from "bun:test";
import { splitAnswerHtml } from "../web/ReviewRoute.tsx";

describe("splitAnswerHtml", () => {
  // Branch 1: trailing top-level <div> is peeled off as the right column.
  test("trailing context <div> goes right; rest stays left", () => {
    const html =
      '<div class="front">知る</div>' +
      '<hr id="answer">' +
      '<div class="context"><img src="/api/anki/media/sentence.png"></div>';
    const { left, right } = splitAnswerHtml(html);

    // Right must contain the context/img.
    expect(right).toContain('class="context"');
    expect(right).toContain("<img");
    expect(right).toContain("sentence.png");

    // Left must contain the front and NOT the context div.
    expect(left).toContain("知る");
    expect(left).not.toContain('class="context"');
  });

  // Branch 2: no trailing div AND no block element after <hr> — guard fires,
  // right must be empty (bare back-answer text stays in single-column).
  // We deliberately use NO top-level <div> so the DOM path doesn't fire,
  // falling all the way to the <hr> regex branch which must reject bare text.
  test("no trailing div + bare text after <hr> → right is empty", () => {
    // Wrap in <span> so there's no top-level <div> for the DOM path to pop.
    const html = "<span>front content</span><hr>just plain back text here";
    const { left, right } = splitAnswerHtml(html);

    expect(right).toBe("");
    // Left should hold the full input.
    expect(left).toContain("front content");
  });

  // Branch 3: <hr> fallback — no top-level div, but right side has a block
  // element (<img>) so the split IS trusted.
  test("hr fallback: block element after <hr> → split is trusted", () => {
    // No wrapping <div> so the top-level-div path doesn't fire.
    // Right side has <img> which counts as a block element.
    const html =
      "front answer text" +
      '<hr id="answer">' +
      '<img src="/api/anki/media/context.png">';
    const { left, right } = splitAnswerHtml(html);

    expect(right).toContain("<img");
    expect(right).toContain("context.png");
    expect(left).toContain("front answer text");
    expect(left).not.toContain("context.png");
  });

  // Branch 4: empty / whitespace-only html → no crash, right is empty.
  test("empty html → right is empty, no crash", () => {
    expect(() => splitAnswerHtml("")).not.toThrow();
    expect(splitAnswerHtml("").right).toBe("");

    expect(() => splitAnswerHtml("   \n   ")).not.toThrow();
    expect(splitAnswerHtml("   \n   ").right).toBe("");
  });

  // Branch 5: multiple top-level divs → ONLY the LAST goes right; all earlier
  // divs stay in the left column.
  test("multiple top-level divs: only the last one goes right", () => {
    const html =
      '<div class="front">単語</div>' +
      '<div class="back">meaning</div>' +
      '<div class="notes">usage note</div>' +
      '<div class="context"><img src="/api/anki/media/img.png"></div>';
    const { left, right } = splitAnswerHtml(html);

    // Only the last (context) div is in right.
    expect(right).toContain('class="context"');
    expect(right).toContain("<img");
    expect(right).not.toContain('class="front"');
    expect(right).not.toContain('class="back"');
    expect(right).not.toContain('class="notes"');

    // All earlier divs stay in left.
    expect(left).toContain('class="front"');
    expect(left).toContain('class="back"');
    expect(left).toContain('class="notes"');
    expect(left).not.toContain('class="context"');
  });
});
