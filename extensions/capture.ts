/**
 * The capture pipeline. PRD §6.2.
 *
 *   RESOLVE -> DISPLAY -> GRAB -> CROP -> SCALE -> ENCODE -> ATTACH
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
	cropRectFor,
	estimateImageTokens,
	fitLongEdge,
	type CropRect,
} from "./geometry.ts";
import { captureWindow, probeOccluders, queryWindow, resolveDisplays } from "./windowinfo.ts";
import type { CaptureFailure, Frame, FrameRecord, SidekickState } from "./state.ts";
import { formatSize } from "./state.ts";

export type CaptureOutcome = { ok: true; frame: Frame; elapsedMs: number } | { ok: false; failure: CaptureFailure; elapsedMs: number };

interface ScreenshotDesktop {
	(options: { screen?: number; format?: string }): Promise<Buffer>;
}

/**
 * Load `screenshot-desktop`, tolerating its CJS default-interop shape.
 *
 * Under ESM the namespace object carries the callable as `.default`, but a
 * transitive CJS require can also land the properties directly on it, so both
 * shapes are accepted rather than assuming one.
 */
async function loadScreenshot(): Promise<ScreenshotDesktop | null> {
	try {
		const mod = (await import("screenshot-desktop")) as unknown as {
			default?: ScreenshotDesktop;
		} & Partial<ScreenshotDesktop>;
		const fn = mod.default ?? (mod as ScreenshotDesktop);
		return typeof fn === "function" ? fn : null;
	} catch {
		return null;
	}
}

/**
 * Capture the bound window's current frame.
 *
 * `reason` is recorded for provenance only — it distinguishes the automatic
 * capture taken when the user pressed Enter from a model-initiated refresh
 * (`game_frame` tool).
 */
export async function captureFrame(state: SidekickState, reason: string): Promise<CaptureOutcome> {
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
	const title = live.title;

	// --- DISPLAY -------------------------------------------------------------
	const displayIndex = binding.displayOverride ?? binding.display?.index ?? 0;
	const displayBounds = binding.display ?? { x: 0, y: 0, width: bounds.width, height: bounds.height };
	let rect: CropRect | null = cropRectFor(bounds, displayBounds);
	if (!rect) {
		// The window migrated to another display. Re-resolve exactly once, then
		// give up rather than loop. (PRD §6.2.3)
		const resolved = await resolveDisplays();
		const match = resolved ? pickDisplay(resolved.displays, bounds) : null;
		if (!match) return { ok: false, failure: { kind: "off-display" }, elapsedMs: Date.now() - started };
		binding.display = match;
		binding.displayOverride = null;
		rect = cropRectFor(bounds, match);
		if (!rect) return { ok: false, failure: { kind: "off-display" }, elapsedMs: Date.now() - started };
	}

	// --- GRAB ----------------------------------------------------------------
	// Ask the window to draw itself before grabbing the display. Cropping a
	// full-desktop shot records whatever is on top of the game, and for this
	// package that is always the terminal holding the conversation — so half of
	// every frame used to be pi. PrintWindow is the only way through an occluder.
	const pipeline = (await import("sharp")).default;
	let full: Buffer | null = await captureWindow(binding.hwnd);
	/** Window titles sitting on top of the game, if we had to fall back. */
	let coveredBy: string[] = [];

	if (full && (await isBlack(full))) full = null;

	if (full) {
		// Already exactly the window. Cropping to the display rect would cut off
		// the very part the window capture just recovered.
		const shot = await pipeline(full).metadata();
		rect = {
			left: 0,
			top: 0,
			width: shot.width ?? bounds.width,
			height: shot.height ?? bounds.height,
		};
	} else {
		const screenshot = await loadScreenshot();
		if (!screenshot) {
			return { ok: false, failure: { kind: "disabled", reason: "screenshot-desktop unavailable" }, elapsedMs: Date.now() - started };
		}
		try {
			full = await screenshot({ screen: displayIndex });
		} catch (error) {
			return {
				ok: false,
				failure: { kind: "disabled", reason: `screen capture failed: ${describe(error)}` },
				elapsedMs: Date.now() - started,
			};
		}
		// The model cannot know something is missing, so the caption has to say so.
		coveredBy = await probeOccluders(binding.hwnd);
	}

	// --- CROP / SCALE / ENCODE ----------------------------------------------
	let encoded: Buffer;
	try {
		encoded = await pipeline(full)
			.extract(rect)
			.resize(fitLongEdge({ width: rect.width, height: rect.height }))
			.jpeg({ quality: JPEG_QUALITY })
			.toBuffer();
	} catch {
		// The window was partly off-screen when the rect was computed. Retry with
		// the rect clamped to the grabbed buffer's own dimensions. (PRD §6.2.4)
		try {
			const meta = await pipeline(full).metadata();
			const w = meta.width ?? displayBounds.width;
			const h = meta.height ?? displayBounds.height;
			const clamped: CropRect = {
				left: Math.max(0, Math.min(rect.left, w - 1)),
				top: Math.max(0, Math.min(rect.top, h - 1)),
				width: Math.max(1, Math.min(rect.width, w - rect.left)),
				height: Math.max(1, Math.min(rect.height, h - rect.top)),
			};
			encoded = await pipeline(full)
				.extract(clamped)
				.resize(fitLongEdge({ width: clamped.width, height: clamped.height }))
				.jpeg({ quality: JPEG_QUALITY })
				.toBuffer();
		} catch (error) {
			return {
				ok: false,
				failure: { kind: "disabled", reason: `crop failed: ${describe(error)}` },
				elapsedMs: Date.now() - started,
			};
		}
	}

	// --- BLACK FRAME CHECK ---------------------------------------------------
	// A GDI screen copy returns an all-black buffer under exclusive fullscreen.
	// Sending that to a vision model produces confident, wrong answers, so it is
	// better to say "no frame" than to send one. (PRD §10 E4)
	if (await isBlack(encoded)) {
		return { ok: false, failure: { kind: "black-frame" }, elapsedMs: Date.now() - started };
	}

	// --- ATTACH --------------------------------------------------------------
	const meta = await pipeline(encoded).metadata();
	const size = { width: meta.width ?? rect.width, height: meta.height ?? rect.height };
	const record: FrameRecord = {
		id: state.nextFrameId++,
		exe: binding.identity.exe,
		width: size.width,
		height: size.height,
		bytes: encoded.byteLength,
		hash: createHash("sha256").update(encoded).digest("hex").slice(0, 12),
		timestamp: Date.now(),
		imageTokens: estimateImageTokens(size),
		// Non-empty only when the desktop-grab fallback was used with something
		// in the way. Travels with the metadata entry so the caption can warn.
		coveredBy,
	};
	const frame: Frame = { record, data: encoded.toString("base64"), mimeType: "image/jpeg" };

	state.framesCaptured++;
	state.frames.push(frame);
	pruneFrames(state);
	state.lastError = null;

	// Provenance metadata only. The base64 payload above never leaves this
	// function. (INV-2, PRD §6.3.2)
	void reason;
	void title;

	return { ok: true, frame, elapsedMs: Date.now() - started };
}

function pickDisplay<T extends { index: number; x: number; y: number; width: number; height: number }>(
	displays: T[],
	bounds: { x: number; y: number; width: number; height: number },
): T | null {
	const cx = bounds.x + bounds.width / 2;
	const cy = bounds.y + bounds.height / 2;
	for (const d of displays) {
		if (cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) return d;
	}
	return null;
}

/** Mean luminance of the red channel; below ~2/255 the frame is effectively black. */
async function isBlack(jpeg: Buffer): Promise<boolean> {
	try {
		const pipeline = (await import("sharp")).default;
		const stats = await pipeline(jpeg).stats();
		return stats.channels[0]?.mean !== undefined && stats.channels[0].mean < 2;
	} catch {
		return false; // never fail a capture just because the check was inconclusive
	}
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

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export { CAPTURE_BUDGET_MS, formatSize };
