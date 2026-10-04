/**
 * Frame attachment — the load-bearing mechanism of this package.
 *
 * PRD §6.3.2, and the reason this file exists in the shape it does:
 *
 *   `before_agent_start` CAN return a replacement user message carrying
 *   ImageContent. That is the obvious way to attach a frame, and it is wrong:
 *   pi persists user messages to the session file, so every turn would write
 *   ~250 KB of base64 JPEG to disk. That violates INV-2 and bloats every
 *   session file on the machine.
 *
 *   So the frame is injected at the `context` event instead. That handler is
 *   request-local: pi restores state afterwards and nothing is written. The
 *   session transcript keeps a `[FRAME #NNN · exe]` caption forever, and the
 *   pixels only ever exist in memory.
 *
 * If the `context` hook stops working, M2 stops and the package is re-scoped.
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { restoreBinding } from "./binding.ts";
import { captionFor, liveFrames, pinnedFrames } from "./frames.ts";
import { formatSize, toRecord, type Frame, type SidekickState } from "./state.ts";

/** Custom entry type for frame provenance. Metadata only — never pixels. */
export const FRAME_ENTRY = "gamer_sidekick_frame";

/**
 * Does this transcript already carry a given frame's caption?
 *
 * The `context` handler runs before *every* LLM call in a turn, including the
 * follow-up calls after a tool result. Re-injecting the same image on each of
 * those would duplicate it and multiply token cost, so injection is keyed off
 * the caption that is already present.
 */
export function hasFrameCaption(messages: unknown[], id: number): boolean {
	const needle = frameCaptionNeedle(id);
	return messages.some((m) => {
		if (!isRecord(m) || m.role !== "user") return false;
		return textOf(m).includes(needle);
	});
}

function frameCaptionNeedle(id: number): string {
	return `[FRAME #${String(id).padStart(3, "0")} ·`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Concatenate the text blocks of a message regardless of its content shape. */
export function textOf(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => isRecord(block) && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Build the user message that carries a frame.
 *
 * Caption first, then the image: providers read content in order, so the model
 * is told what it is looking at before it looks at it.
 */
export function buildFrameMessage(frame: Frame, timestamp: number): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: captionFor(frame) },
			{ type: "image", data: frame.data, mimeType: frame.mimeType },
		],
		timestamp,
	};
}

/**
 * Wire the two hooks that move a frame from the game screen into the request.
 */
export function registerAttachment(
	pi: ExtensionAPI,
	state: SidekickState,
	/** Injection point for tests; production always uses the real capture. */
	capture: typeof captureFrame = captureFrame,
): void {
	// --- 1. capture on submit ------------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		await state.ready;
		if (!state.available) return;

		// The binding may have been written by a `/gs play` that switched *into*
		// this session after `session_start` had already fired — the entry lands
		// in the new file, but the instance that read session_start has moved on
		// and this one starts empty. Re-read before anything needs a window, or
		// this turn answers "no game bound" for a window that is very much bound.
		if (!state.binding) {
			const identity = await restoreBinding(state, ctx.sessionManager?.getEntries?.());
			if (identity) {
				ctx.ui.setStatus("gamer-sidekick", statusText(state));
				ctx.ui.notify(`Resumed capture for ${identity.exe}.`, "info");
			}
		}

		if (!state.binding) {
			if (!state.promptHintShown) {
				state.promptHintShown = true;
				ctx.ui.notify("Gamer Sidekick: no game bound — run /gs play to start capturing frames.", "info");
			}
			state.pendingFrame = null;
			return;
		}

		const outcome = await capture(state, "prompt");
		state.pendingFrame = outcome.ok ? outcome.frame : null;

		if (outcome.ok) {
			state.framesAttached++;
			// Provenance only. The base64 payload stays in `state.frames` in RAM.
			pi.appendEntry(FRAME_ENTRY, { ...toRecord(outcome.frame), reason: "prompt" });
		} else {
			state.framesDropped++;
			state.lastError = describeFailure(outcome.failure);
			// Deliberately no throw and no block: the question still goes through.
		}

		// No message is returned here on purpose. See the file header.
		void event;
	});

	// --- 2. inject at request time ------------------------------------------
	pi.on("context", async (event) => {
		const injected: Frame[] = [];

		for (const frame of pinnedFrames(state)) {
			if (!hasFrameCaption(event.messages, frame.record.id)) injected.push(frame);
		}
		for (const frame of liveFrames(state)) {
			if (!hasFrameCaption(event.messages, frame.record.id)) injected.push(frame);
		}
		if (injected.length === 0) return;

		const now = Date.now();
		const pins = injected.filter((f) => f.record.pinned);
		const live = injected.filter((f) => !f.record.pinned);

		// Pinned frames go at the head, oldest first, so the model has the
		// "before" reference before it reads the current turn.
		const head = pins.map((f) => buildFrameMessage(f, now));
		const tail = live.map((f) => buildFrameMessage(f, now));

		return { messages: [...head, ...event.messages, ...tail] };
	});
}

/** Human-readable reason for a capture failure. Maps onto PRD §10. */
export function describeFailure(failure: { kind: string; reason?: string }): string {
	switch (failure.kind) {
		case "no-binding":
			return "no game bound";
		case "stale-binding":
			return "bound window is gone — run /gs play";
		case "minimized":
			return "bound window is minimized";
		case "off-display":
			return "bound window is not on a known display";
		case "black-frame":
			return "capture returned a black frame — the game may be in exclusive fullscreen";
		case "no-display":
			return "no display geometry available";
		case "disabled":
			return failure.reason ?? "capture is unavailable";
		default:
			return failure.kind;
	}
}

/** One-line status summary for the footer. PRD §6.6.3. */
export function statusText(state: SidekickState): string | undefined {
	if (!state.available) {
		// `disabledReason` is null while the probe is still running.
		return state.disabledReason ? "[SIDEKICK · unavailable]" : "[SIDEKICK · starting…]";
	}
	if (!state.binding) return "[SIDEKICK · no game bound · /gs play]";

	const b = state.binding;
	const size = formatSize({ width: b.bounds.width, height: b.bounds.height });
	const stale = state.bindingStale ? " · stale" : "";
	const pins = state.pinned.length > 0 ? ` · ${state.pinned.length} pinned` : "";
	const frames = `${state.framesCaptured} frame${state.framesCaptured === 1 ? "" : "s"}`;
	return `[SIDEKICK · ${b.identity.exe} · ${size} · ${frames}${pins}${stale}]`;
}
