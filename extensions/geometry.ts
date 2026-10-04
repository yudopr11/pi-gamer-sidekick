/**
 * Image geometry and the frame budget.
 *
 * Pure functions, no I/O — fully unit tested (see test/geometry.test.ts).
 *
 * Frame bytes are the most expensive thing this package sends, so the sizing
 * rules live here in one auditable place rather than being sprinkled through
 * the capture pipeline. §6.2.2 and §6.3.3 of the PRD.
 */

/** Long edge a captured frame is scaled down to. Never upscaled. */
export const MAX_LONG_EDGE = 1280;

/** JPEG quality used for the re-encode. */
export const JPEG_QUALITY = 80;

/** Per-image request budget in seconds. Over this, E10 fires. */
export const CAPTURE_BUDGET_MS = 3000;

export interface Size {
	width: number;
	height: number;
}

/** Scale a size down so its long edge is at most `maxLongEdge`. Never upscales. */
export function fitLongEdge(size: Size, maxLongEdge: number = MAX_LONG_EDGE): Size {
	const long = Math.max(size.width, size.height);
	if (long <= maxLongEdge || long === 0) return size;

	const scale = maxLongEdge / long;
	return {
		width: Math.max(1, Math.round(size.width * scale)),
		height: Math.max(1, Math.round(size.height * scale)),
	};
}

export interface CropRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Translate a window rectangle (virtual-desktop coordinates) into a crop
 * rectangle for a single display's screenshot buffer.
 *
 * `windowBounds` is in virtual desktop space; `displayBounds` is the origin of
 * the display that was grabbed. Returns `null` when the window does not
 * overlap the display at all, which is the signal to re-resolve the display
 * rather than to crop garbage. §6.2.3.
 */
export function cropRectFor(
	windowBounds: { x: number; y: number; width: number; height: number },
	displayBounds: { x: number; y: number; width: number; height: number },
): CropRect | null {
	if (windowBounds.width <= 0 || windowBounds.height <= 0) return null;
	if (displayBounds.width <= 0 || displayBounds.height <= 0) return null;

	const left = windowBounds.x - displayBounds.x;
	const top = windowBounds.y - displayBounds.y;

	// Intersect, then clamp. A window dragged half off the edge yields the
	// visible half rather than an error (PRD §6.2.4, "crop fails" row).
	const x1 = Math.max(0, left);
	const y1 = Math.max(0, top);
	const x2 = Math.min(displayBounds.width, left + windowBounds.width);
	const y2 = Math.min(displayBounds.height, top + windowBounds.height);

	if (x2 <= x1 || y2 <= y1) return null;
	return { left: Math.round(x1), top: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

/**
 * Which display contains a window's centre point?
 *
 * `screenshot-desktop.listDisplays()` returns no bounds, so display geometry is
 * resolved once at bind time and cached. This is the lookup used at bind time
 * and again if a window migrates between displays at runtime. §6.2.3.
 */
export function displayForWindow(
	windowBounds: { x: number; y: number; width: number; height: number },
	displays: { index: number; x: number; y: number; width: number; height: number }[],
): { index: number; x: number; y: number; width: number; height: number } | null {
	const cx = windowBounds.x + windowBounds.width / 2;
	const cy = windowBounds.y + windowBounds.height / 2;
	for (const d of displays) {
		if (cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) return d;
	}
	return null;
}

/**
 * OpenAI vision token estimate for an image.
 *
 * Images are tiled into 512px squares, each costing 85 tokens, plus a fixed
 * 85-token base. This is an *estimate* for the status display only — pi owns
 * authoritative accounting. §6.8.
 */
export function estimateImageTokens(size: Size): number {
	const tiles = Math.ceil(size.width / 512) * Math.ceil(size.height / 512);
	return 85 * tiles + 85;
}
