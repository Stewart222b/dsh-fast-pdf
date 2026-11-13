/**
 * Where the translate bubble should hang: the end of the selection, not its box.
 *
 * A multi-line selection's `getBoundingClientRect()` is the union of every line,
 * so hanging a pill off its right edge puts the pill at the far side of the pane
 * — nowhere near the words the reader just let go of. The extension this pane is
 * ported from works from the *client rects* of the focus end instead, and this is
 * that file.
 *
 * One deliberate omission: upstream also refuses to answer unless the selection
 * sits inside `.textLayer`. That check lives in the caller here (`onSelect`
 * already proves the range is inside the page container), so a second guard would
 * only repeat it.
 *
 * @typedef {{ left: number, top: number, right: number, bottom: number,
 *   width: number, height: number }} RectLike
 */

function isValidRect(rect) {
  return rect && rect.width >= 0 && rect.height > 0;
}

function rectsIntersectViewport(rect, viewport) {
  return (
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom &&
    rect.right >= viewport.left &&
    rect.left <= viewport.right
  );
}

/**
 * The last visible rect, else the last rect at all.
 *
 * @param {RectLike[]} rects
 * @param {RectLike | null} [viewportRect]
 */
function pickLastVisibleOrLast(rects, viewportRect) {
  if (!rects.length) return null;
  if (!viewportRect) return rects[rects.length - 1];
  const visible = rects.filter((rect) => rectsIntersectViewport(rect, viewportRect));
  const pool = visible.length ? visible : rects;
  return pool[pool.length - 1];
}

/** A collapsed range at the focus end — the point the reader's pointer left. */
function focusEndpointRange(range, selection = null) {
  const focusNode = selection?.focusNode;
  const focusOffset = selection?.focusOffset;
  if (typeof document === "undefined" || !focusNode || typeof focusOffset !== "number") {
    const endRange = range.cloneRange();
    endRange.collapse(false);
    return endRange;
  }
  const focusRange = document.createRange();
  try {
    focusRange.setStart(focusNode, focusOffset);
    focusRange.collapse(true);
    return focusRange;
  } catch {
    const endRange = range.cloneRange();
    endRange.collapse(false);
    return endRange;
  }
}

/**
 * The rect to hang the bubble under.
 *
 * @param {Range} range
 * @param {RectLike | null} [viewportRect]
 * @param {Selection | null} [selection]
 * @returns {RectLike | null}
 */
export function getSelectionAnchorRect(range, viewportRect = null, selection = null) {
  const endRange = focusEndpointRange(range, selection);
  const endRects = [...endRange.getClientRects()].filter(isValidRect);
  const endAnchor = pickLastVisibleOrLast(endRects, viewportRect);
  if (endAnchor) return endAnchor;

  const endBox = endRange.getBoundingClientRect();
  if (isValidRect(endBox) && (!viewportRect || rectsIntersectViewport(endBox, viewportRect))) {
    return endBox;
  }

  const clientRects = [...range.getClientRects()].filter(isValidRect);
  const fromClients = pickLastVisibleOrLast(clientRects, viewportRect);
  if (fromClients) return fromClients;

  if (isValidRect(endBox)) return endBox;
  const union = range.getBoundingClientRect();
  if (isValidRect(union) && union.height > 200 && clientRects.length > 1) {
    return clientRects[clientRects.length - 1];
  }
  return union;
}

/**
 * @param {Selection} selection
 * @param {RectLike | null} [viewportRect]
 * @returns {RectLike | null}
 */
export function getSelectionAnchorFromSelection(selection, viewportRect = null) {
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return getSelectionAnchorRect(range, viewportRect, selection);
}
