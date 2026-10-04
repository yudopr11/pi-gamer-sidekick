/**
 * The capture pipeline. PRD §6.2.
 *
 *   RESOLVE -> DISPLAY -> GRAB -> SCALE -> ENCODE -> ATTACH
 *
 * GRAB, SCALE and ENCODE are one PowerShell round trip. The shim renders the
 * window, scales it, encodes it and reports its own statistics, so the only
 * thing that crosses the process boundary is the finished frame. Doing it the
 * other way round — PNG out, decode, crop, resize, encode — moved 5.9 MB of
 * base64 per capture to save ~150 KB. (PRD §11 R-9)
 *
 * Two rules govern everything here:
 *
 *   INV-1  Capture never blocks or degrades the game. It runs on pi's thread,
 *          only after the user pressed Enter, and is bounded by CAPTURE_BUDGET_MS.
 *   INV-4  A capture failure never fails the user's question. Every failure
 *          returns a typed reason that the caller reports, never a throw.
 */

import { createHash } from "node:crypto";
import {
	CAPTURE_BUDGET_MS,
	JPEG_QUALITY,
	MAX_LONG_EDGE,
	cropRectFor,
	estimateImageTokens,
	type CropRect,
} from "./geometry.ts";
import { captureWindowJpeg, displayFor, grabRegion, probeOccluders, queryWindow, resolveDisplays, type Shot } from "./windowinfo.ts";
import { recordFrame } from "./ledger.ts";
import type { CaptureFailure, Frame, FrameRecord, SidekickState } from "./state.ts";

export type CaptureOutcome = { ok: true; frame: Frame; elapsedMs: number } | { ok: false; failure: CaptureFailure; elapsedMs: number };

/**
 * Mean red channel below this reads as black.
 *
 * A GDI screen copy returns an all-zero buffer under exclusive fullscreen.
 * Sending that to a vision model produces confident, wrong answers, so it is
 * better to say "no frame" than to send one. (PRD §10 E4)
 */
const BLACK_RED_MEAN = 2;

/**
 * Capture the bound window's current frame.
 */
export async function captureFrame(state: SidekickState): Promise<CaptureOutcome> {
	const started = Date.now();

	if (!state.available) {
		return { ok: false, failure: { kind: "disabled", reason: state.disabledReason ?? "unavailable" }, elapsedMs: 0 };
	}
	const binding = state.binding;
	if (!binding) return { ok: false, failure: { kind: "no-binding" }, elapsedMs: Date.now() - started };

	// --- RESOLVE -------------------------------------------------------------
	// The HWND is never trusted. Windows recycles handles, so a binding written
	// last week can point at an unrelated window today. One targeted query, not
	// a full enumeration — this runs on the capture path. (PRD §11 R-5)
	const live = await queryWindow(binding.hwnd);
	if (!live) {
		state.bindingStale = true;
		return { ok: false, failure: { kind: "stale-binding" }, elapsedMs: Date.now() - started };
	}
	if (live.minimized || live.bounds.width === 0 || live.bounds.height === 0) {
		return { ok: false, failure: { kind: "minimized" }, elapsedMs: Date.now() - started };
	}
	const bounds = live.bounds;

	// --- DISPLAY -------------------------------------------------------------
	const displayIndex = binding.displayOverride ?? binding.display?.index ?? 0;
	const displayBounds = binding.display ?? { x: 0, y: 0, width: bounds.width, height: bounds.height };
	let rect: CropRect | null = cropRectFor(bounds, displayBounds);
	if (!rect) {
		// The window migrated to another display. Re-resolve exactly once, then
		// give up rather than loop. (PRD §6.2.3)
		const resolved = await resolveDisplays();
		const match = resolved ? displayFor(resolved.displays, bounds) : null;
		if (!match) return { ok: false, failure: { kind: "off-display" }, elapsedMs: Date.now() - started };
		binding.display = match;
		binding.displayOverride = null;
		rect = cropRectFor(bounds, match);
		if (!rect) return { ok: false, failure: { kind: "off-display" }, elapsedMs: Date.now() - started };
	}

	// --- GRAB / SCALE / ENCODE ----------------------------------------------
	// Ask the window to draw itself before grabbing the display. Cropping a
	// full-desktop shot records whatever is on top of the game, and for this
	// package that is always the terminal holding the conversation — so half of
	// every frame used to be pi. PrintWindow is the only way through an occluder.
	let shot: Shot | null = await captureWindowJpeg(binding.hwnd, MAX_LONG_EDGE, JPEG_QUALITY);
	/** Window titles sitting on top of the game, if we had to fall back. */
	let coveredBy: string[] = [];

	if (shot && shot.redMean < BLACK_RED_MEAN) shot = null;

	if (!shot) {
		// The window would not draw itself. Fall back to the region of the
		// display it sits on — which records whatever is in the way, so ask what
		// is in the way and let the caption say so.
		const fallback = await grabRegion(displayIndex, rect, MAX_LONG_EDGE, JPEG_QUALITY);
		if (!fallback) {
			return {
				ok: false,
				failure: { kind: "disabled", reason: "the window would not render and the display grab failed" },
				elapsedMs: Date.now() - started,
			};
		}
		shot = fallback;
		coveredBy = await probeOccluders(binding.hwnd);
	}

	// --- BLACK FRAME CHECK ---------------------------------------------------
	if (shot.redMean < BLACK_RED_MEAN) {
		return { ok: false, failure: { kind: "black-frame" }, elapsedMs: Date.now() - started };
	}

	// --- ATTACH --------------------------------------------------------------
	const size = { width: shot.width, height: shot.height };
	const record: FrameRecord = {
		id: state.nextFrameId++,
		exe: binding.identity.exe,
		width: size.width,
		height: size.height,
		bytes: shot.jpeg.byteLength,
		hash: createHash("sha256").update(shot.jpeg).digest("hex").slice(0, 12),
		timestamp: Date.now(),
		imageTokens: estimateImageTokens(size),
		// Non-empty only when the display-grab fallback was used with something
		// in the way. Travels with the metadata entry so the caption can warn.
		coveredBy,
	};
	const frame: Frame = { record, data: shot.jpeg.toString("base64"), mimeType: "image/jpeg" };

	recordFrame(state, record);
	state.frames.push(frame);
	pruneFrames(state);
	state.lastError = null;

	return { ok: true, frame, elapsedMs: Date.now() - started };
}

/**
 * Keep the in-memory frame ledger bounded.
 *
 * Frames are kept only so `/gs frames` and `/gs status` have a recent ledger.
 * The conversation holds its own copies, so this buffer falls off the end once
 * it exceeds a small tail rather than the package holding megabytes of base64
 * for the whole session.
 */
function pruneFrames(state: SidekickState): void {
	const keep = 8;
	while (state.frames.length > keep) state.frames.shift();
}
