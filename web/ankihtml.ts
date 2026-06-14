// Sanitizer for Anki template HTML, extracted from ReviewRoute so it can be
// unit-tested with bun:test (under a DOM provided by happy-dom). The previous
// regex sanitizer was bypassable (mutation XSS, <svg onload>, slash-separated
// attributes); this uses DOMPurify per /tmp/wave16-review-xss.md §3.

import createDOMPurify from "dompurify";

// DOMPurify's default export auto-initializes against `window` in a real browser
// (the web bundle), where `.sanitize` is ready immediately. When the module is
// evaluated before a DOM exists (e.g. bun:test before happy-dom, or any
// non-window context), the export is an uninitialized factory whose `.sanitize`
// is undefined — so bind it to the global window lazily on first use.
type Purifier = { sanitize: (s: string, cfg?: object) => string };

let purifier: Purifier | null = null;
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const dp = createDOMPurify as unknown as
    & Purifier
    & ((win: typeof globalThis.window) => Purifier);
  purifier = typeof dp.sanitize === "function" ? dp : dp(globalThis.window);
  return purifier;
}

/** Same-origin sanitizer for Anki card HTML rendered via dangerouslySetInnerHTML.
 *  The HTML is user-authored/shared-deck content and must be treated as untrusted.
 *  DOMPurify strips <script>, all on* handlers, and unsafe URI schemes
 *  (javascript:/vbscript:/data:) by default. We allowlist the tags/attrs Anki
 *  cards rely on (<style>, furigana <ruby>/<rt>/<rp>/<rb>/<rtc>, <img>,
 *  <audio>/<source>, inline formatting/tables) and forbid script-capable
 *  containers (<script>/<iframe>/<svg>/<object>/<embed>/<base>/<meta>/<form>/<link>).
 *  Signature unchanged so ReviewRoute's import stays the same. */
export function sanitizeAnkiHtml(html: string): string {
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS: [
      "div", "span", "p", "br", "hr", "b", "i", "u", "em", "strong",
      "sub", "sup", "small", "mark", "s", "del", "ins",
      "ul", "ol", "li", "dl", "dt", "dd",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
      "img", "audio", "source", "a", "font", "center", "blockquote", "pre", "code",
      "ruby", "rt", "rp", "rb", "rtc", // furigana — KEEP
      "style", // KEEP (Anki cards rely on it)
      "h1", "h2", "h3", "h4", "h5", "h6",
    ],
    ALLOWED_ATTR: [
      "class", "id", "style", "src", "alt", "title", "href", "controls", "preload",
      "colspan", "rowspan", "width", "height", "lang", "dir", "color", "face",
      "type", "loop", "muted", "autoplay", "span",
    ],
    FORBID_TAGS: [
      "script", "iframe", "object", "embed", "base", "meta", "form", "link", "svg", "math",
    ],
    FORBID_ATTR: ["srcdoc", "srcset", "formaction", "xlink:href"],
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
}
