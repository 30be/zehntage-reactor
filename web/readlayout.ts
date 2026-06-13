// Pure read-view layout helpers (no React/DOM). Bun-testable.

/** Clamp a word-popup position to stay within the viewport. Given the clicked
 * token's client rect and the viewport size, return viewport-space {x, y} for
 * an absolutely-positioned popup: flips above the word when a below-word popup
 * would spill past the bottom, and keeps x within the horizontal bounds. The
 * caller adds scrollX/scrollY to convert to document coords. */
export function clampPopupPos(
  rect: { left: number; top: number; bottom: number },
  vw: number,
  vh: number,
  popupW = 340,
  popupH = 260,
  gap = 6,
): { x: number; y: number } {
  const below = rect.bottom + gap;
  const flipUp = below + popupH > vh && rect.top - gap - popupH > 0;
  return {
    x: Math.max(8, Math.min(rect.left, vw - popupW)),
    y: flipUp ? rect.top - gap - popupH : below,
  };
}
