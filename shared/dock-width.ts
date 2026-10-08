/**
 * How wide the assistant dock is allowed to be.
 *
 * The dock is a second panel in a window whose first panel is the picture grid.
 * That makes the two compete, and the grid is the one doing the job the app
 * exists for, so the dock yields: it never takes more than a share of the window,
 * and it never falls below a width at which the composer and the model name stop
 * fitting.
 *
 * Both the render and the drag handle call `clampDockWidth` rather than deciding
 * their own bounds, because two copies of a clamp is how a dock ends up at 240px
 * on a 360px window: one of them applied the floor last, and last wins.
 */

/** Below this the composer and the model name start clipping. */
export const DOCK_MIN_WIDTH = 240
/** Above this the chat stops being a panel and starts being the app. */
export const DOCK_MAX_WIDTH = 720
/**
 * The dock's share of the window.
 *
 * A narrow window is where this matters. A 60/40 split on a normal window leaves
 * the grid comfortable; the same 240px floor on a 360px window would be two
 * thirds of it, which is not a panel, it is a leftover.
 */
export const DOCK_MAX_SHARE = 0.6

/**
 * The width to render, given a stored preference and the current window.
 *
 * The floor goes on first so the window share is the last word: on a window too
 * narrow to hold both, the dock gets less than its minimum rather than the grid
 * getting less than its share. The floor still raises a stored width that is
 * pointlessly narrow, because that costs the grid nothing.
 *
 * Below 400px of window that leaves the share as both the cap and the floor, so
 * the dock is pinned to exactly 60% and dragging it does nothing. That is the
 * deliberate outcome rather than a leftover: a window that narrow has no width to
 * negotiate with, and the way out is the collapse button, not a drag that snaps
 * back. Anything else would mean inventing a second floor for one window size.
 */
export function clampDockWidth(preferred: number, viewportWidth: number): number {
  const preferredWidth = Number.isFinite(preferred) ? Math.round(preferred) : DOCK_MIN_WIDTH
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.round(viewportWidth)) : 0
  return Math.min(
    Math.max(preferredWidth, DOCK_MIN_WIDTH),
    DOCK_MAX_WIDTH,
    Math.round(viewport * DOCK_MAX_SHARE)
  )
}

/**
 * Where a drag puts the dock.
 *
 * The origin is the width on screen rather than the stored preference, so a drag
 * that starts on a capped window continues from what the user can see instead of
 * snapping the dock wider before the pointer has moved.
 */
export function dragDockWidth(
  startWidth: number,
  startX: number,
  clientX: number,
  viewportWidth: number
): number {
  return clampDockWidth(startWidth + (startX - clientX), viewportWidth)
}