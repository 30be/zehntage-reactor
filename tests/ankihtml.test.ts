// XSS-surface tests for the Anki card HTML sanitizer (Wave 16). The sanitizer
// must KILL scripts / on* handlers / javascript: URLs while PRESERVING the
// constructs Anki cards rely on (style, furigana ruby/rt, img/audio, inline
// formatting). See /tmp/wave16-review-xss.md for the threat model.

// DOMPurify needs a DOM. We use jsdom (DOMPurify's reference test env) rather
// than happy-dom: happy-dom reports DOMPurify.isSupported === false, which makes
// DOMPurify a NO-OP (it returns input ~unchanged, leaking <script> content) —
// useless for a security test. jsdom sanitizes correctly. The one jsdom gap is
// <style>: jsdom lacks the CSSOM (`element.sheet`) DOMPurify's CSS sanitizer
// needs, so it drops <style> here even though real browsers keep it — those
// assertions are env-guarded below (the web bundle preserves <style>).
// Minimal local typing for jsdom — we deliberately don't depend on
// @types/jsdom: it bundles a conflicting DOM lib that breaks the rest of the
// project's tsc (Uint8Array/BodyInit). We only need JSDOM here.
// @ts-ignore — runtime-only import, typed locally below.
import { JSDOM as JSDOMRuntime } from "jsdom";
// Loose local type (the root tsconfig has no DOM lib; we only touch .window and
// .window.document.querySelector here).
// deno-lint-ignore no-explicit-any
const JSDOM = JSDOMRuntime as new (html: string) => { window: any };

const dom = new JSDOM("");
// deno-lint-ignore no-explicit-any
(globalThis as any).window = dom.window;
// deno-lint-ignore no-explicit-any
(globalThis as any).document = dom.window.document;

import { describe, expect, test } from "bun:test";
import { sanitizeAnkiHtml } from "../web/ankihtml.ts";

// Whether the active DOM preserves <style> through DOMPurify (true in browsers,
// false under jsdom). Probe it once so style-preservation assertions only run
// where the environment can actually keep <style>.
const STYLE_KEPT = /<style/i.test(sanitizeAnkiHtml("<style>.x{color:red}</style>"));

describe("sanitizeAnkiHtml — XSS removal", () => {
  test("strips <script>…</script> blocks", () => {
    const out = sanitizeAnkiHtml('<b>hi</b><script>alert(1)</script><i>bye</i>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<b>hi</b>");
    expect(out).toContain("<i>bye</i>");
  });

  test("strips unterminated / bare <script> tags", () => {
    // An unterminated <script> swallows the rest as (removed) script content per
    // the HTML parser — the key guarantee is no <script> and no live JS survives.
    const out = sanitizeAnkiHtml('<script src="evil.js">text after');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("evil.js");
  });

  test("removes <img onerror=...> handler (double-quoted)", () => {
    const out = sanitizeAnkiHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain("alert(1)");
    // the img itself + its src survive
    expect(out).toMatch(/<img/i);
    expect(out).toMatch(/src="x"/);
  });

  test("removes <svg onload=...> (regex sanitizer missed this)", () => {
    const out = sanitizeAnkiHtml('<svg onload="alert(1)"></svg>');
    expect(out).not.toMatch(/<svg/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toContain("alert(1)");
  });

  test("removes <svg><script> nested script", () => {
    const out = sanitizeAnkiHtml("<svg><script>alert(1)</script></svg>");
    expect(out).not.toMatch(/<svg/i);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
  });

  test("neutralizes slash-separated <img/src=x/onerror=...> (regex missed this)", () => {
    // The HTML parser folds the slash-payload into a single inert `src`
    // attribute value — there is NO live `onerror` event-handler attribute, so
    // it can never fire. Assert real safety via the parsed DOM, not substrings.
    const out = sanitizeAnkiHtml("<img/src=x/onerror=alert(1)>");
    const probe = new JSDOM(`<body>${out}</body>`);
    const img = probe.window.document.querySelector("img");
    expect(img?.hasAttribute("onerror")).toBe(false);
    // it survives only as inert text inside the src value, never as a handler.
    expect(img?.getAttribute("src")).toBe("x/onerror=alert(1)");
  });

  test("removes on* handler (single-quoted)", () => {
    const out = sanitizeAnkiHtml("<div onclick='steal()'>x</div>");
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toContain("steal()");
    expect(out).toContain(">x</div>");
  });

  test("removes on* handler (unquoted)", () => {
    const out = sanitizeAnkiHtml("<img src=x onerror=alert(1)>");
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toMatch(/<img/i);
  });

  test("removes various on* handlers (onload, onmouseover, onanimationstart)", () => {
    const out = sanitizeAnkiHtml(
      '<div onload="a()" onmouseover="b()" onanimationstart="c()">z</div>',
    );
    expect(out).not.toMatch(/on(load|mouseover|animationstart)/i);
    expect(out).not.toMatch(/[abc]\(\)/);
    expect(out).toContain(">z</div>");
  });

  test("neutralizes javascript: URL in href (quoted)", () => {
    const out = sanitizeAnkiHtml('<a href="javascript:alert(1)">go</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain(">go</a>");
  });

  test("neutralizes javascript: URL in src (unquoted)", () => {
    const out = sanitizeAnkiHtml("<img src=javascript:alert(1)>");
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toContain("alert(1)");
  });
});

describe("sanitizeAnkiHtml — preservation of legit Anki constructs", () => {
  test("keeps <style> blocks (browser only) + surrounding content", () => {
    const html = "<style>.card { color: red; }</style><div>hi</div>";
    const out = sanitizeAnkiHtml(html);
    if (STYLE_KEPT) {
      expect(out).toMatch(/<style>[\s\S]*color: red[\s\S]*<\/style>/);
    }
    expect(out).toContain("<div>hi</div>");
  });

  test("keeps furigana <ruby><rt>", () => {
    const html = "<ruby>漢字<rt>かんじ</rt></ruby>";
    const out = sanitizeAnkiHtml(html);
    expect(out).toContain("<ruby>");
    expect(out).toContain("漢字");
    expect(out).toContain("<rt>かんじ</rt>");
  });

  test("keeps <img src> (no handler)", () => {
    const html = '<img src="/api/anki/media/pic.png" alt="pic">';
    const out = sanitizeAnkiHtml(html);
    expect(out).toMatch(/<img/i);
    expect(out).toMatch(/src="\/api\/anki\/media\/pic\.png"/);
    expect(out).toMatch(/alt="pic"/);
  });

  test("keeps <audio>/<source>", () => {
    const html =
      '<audio controls preload="none"><source src="/api/anki/media/a.mp3"></audio>';
    const out = sanitizeAnkiHtml(html);
    expect(out).toMatch(/<audio/i);
    expect(out).toContain("<source");
    expect(out).toMatch(/src="\/api\/anki\/media\/a\.mp3"/);
  });

  test("keeps inline formatting <b>/<i>/<span>", () => {
    const html = '<b>bold</b><i>ital</i><span class="x">sp</span>';
    const out = sanitizeAnkiHtml(html);
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<i>ital</i>");
    expect(out).toMatch(/<span class="x">sp<\/span>/);
  });

  test("keeps furigana + styles together while killing a handler", () => {
    const html =
      '<style>.card{font-size:2em}</style>' +
      '<div class="card"><ruby>勉強<rt>べんきょう</rt></ruby>' +
      '<img src="/api/anki/media/x.png" onerror="alert(1)"></div>';
    const out = sanitizeAnkiHtml(html);
    // preserved
    if (STYLE_KEPT) {
      expect(out).toMatch(/<style>[\s\S]*font-size:2em[\s\S]*<\/style>/);
    }
    expect(out).toContain("<rt>べんきょう</rt>");
    expect(out).toMatch(/src="\/api\/anki\/media\/x\.png"/);
    // killed
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain("alert(1)");
  });
});
