/**
 * Above or below, and how tall the bubble may be — in the extension's own rules.
 *
 * The pane is narrow and short, so "under the selection" is not always possible:
 * near the bottom of a page the card has to go up, and its height has to be
 * capped to what is left rather than being cut off by the frame's overflow.
 * Both answers come from the same arithmetic here so they cannot disagree.
 *
 * @typedef {{ left: number, top: number, right: number, bottom: number,
 *   width: number, height: number }} RectLike
 */

export const BUBBLE_GAP = 8;
export const BUBBLE_MARGIN = 8;
export const BUBBLE_MIN_HEIGHT = 72;
/** Height to assume when choosing a side: a card that has not drawn yet has none. */
export const BUBBLE_PLACEMENT_ESTIMATE = 280;

/**
 * @param {RectLike} selectionRect
 * @param {RectLike} viewportRect - the scrollport the bubble floats over.
 * @param {number} bubbleWidth
 * @param {number} bubbleHeight - measured natural height (0 before first paint).
 * @param {{ gap?: number, margin?: number, minHeight?: number,
 *   placementEstimate?: number }} [options]
 */
export function computeBubblePlacement(selectionRect, viewportRect, bubbleWidth, bubbleHeight, options = {}) {
  const gap = options.gap ?? BUBBLE_GAP;
  const margin = options.margin ?? BUBBLE_MARGIN;
  const minHeight = options.minHeight ?? BUBBLE_MIN_HEIGHT;
  const placementHeight = Math.max(
    bubbleHeight,
    options.placementEstimate ?? BUBBLE_PLACEMENT_ESTIMATE,
  );

  const belowTop = selectionRect.bottom + gap;
  const spaceBelow = viewportRect.bottom - margin - belowTop;
  const spaceAbove = selectionRect.top - gap - (viewportRect.top + margin);

  let placeBelow;
  if (spaceBelow >= placementHeight) placeBelow = true;
  else if (spaceAbove >= placementHeight) placeBelow = false;
  else placeBelow = spaceBelow >= spaceAbove;

  const available = placeBelow ? spaceBelow : spaceAbove;
  const effectiveHeight = Math.min(bubbleHeight, Math.max(available, minHeight));

  let top = placeBelow
    ? belowTop
    : selectionRect.top - gap - effectiveHeight;

  const minTop = viewportRect.top + margin;
  const maxTop = viewportRect.bottom - margin - minHeight;
  top = Math.min(Math.max(top, minTop), maxTop);

  const minLeft = viewportRect.left + margin;
  const maxLeft = viewportRect.right - margin - bubbleWidth;
  const left = maxLeft < minLeft
    ? minLeft
    : Math.min(Math.max(selectionRect.left, minLeft), maxLeft);

  // Clamping can push a tall bubble over the line it came from (a selection in
  // the middle of the page). If the bubble covers the anchor, try the other side
  // once before accepting the overlap.
  const renderedHeight = (candidateTop) =>
    Math.min(bubbleHeight, Math.max(viewportRect.bottom - margin - candidateTop, minHeight));
  const coversSelection = (candidateTop) =>
    candidateTop < selectionRect.bottom + gap &&
    candidateTop + renderedHeight(candidateTop) > selectionRect.top - gap &&
    left < selectionRect.right &&
    left + bubbleWidth > selectionRect.left;
  if (coversSelection(top)) {
    const flipped = placeBelow
      ? selectionRect.top - gap - effectiveHeight
      : belowTop;
    const clampedFlipped = Math.min(Math.max(flipped, minTop), maxTop);
    if (!coversSelection(clampedFlipped)) top = clampedFlipped;
  }

  let maxHeight = viewportRect.bottom - margin - top;
  maxHeight = Math.max(maxHeight, minHeight);

  return { left, top, maxHeight, placeBelow };
}

/** The widest a card may be in this viewport. */
export function maxBubbleWidthForViewport(viewportRect, options = {}) {
  const margin = options.margin ?? BUBBLE_MARGIN;
  const cap = options.absoluteMax ?? 420;
  const viewportWidth = viewportRect.right - viewportRect.left;
  return Math.min(cap, Math.max(1, viewportWidth - margin * 2));
}
