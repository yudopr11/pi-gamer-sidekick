/**
 * Frame attachment — the load-bearing mechanism of this package.
 *
 * PRD §6.3.2, amended by A2.
 *
 * The captured frame is returned from `before_agent_start` as a custom message
 * carrying the caption and the image. pi appends it to the conversation right
 * after the player's question, which is all it takes to make the frame an
 * ordinary part of the transcript:
 *
 *   - it reaches the model as a user message with an image block
 *     (`convertToLlm` maps `role:"custom"` onto `role:"user"`, content intact);
 *   - it is persisted, so `/resume` brings the frame back with the conversation;
 *   - it stays in context on later turns without anything re-attaching it.
 *
 * The one thing it does not do is *render* the image in the terminal: pi's
 * CustomMessageComponent shows the text blocks and drops the rest, for a live
 * turn and a resumed one alike. The picture reaches the model; the player sees
 * the caption. That is why there is no pinning — a pin existed to force a frame
 * into context, and a frame that is simply in the conversation does that — and
 * also why `game_frame` is still registered: it is the only path that returns
 * an image as a tool result, and tool results do render.
 *
 * The cost is disk: a custom message is a session entry, so each captured
 * frame writes its base64 JPEG into the session JSONL. A 1280px frame is
 * ~150 KB. That is the price of a frame you can scroll back to, and it is the
 * player's call to make.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { restoreBinding } from "./binding.ts";
import { captionFor } from "./frames.ts";
import { FRAME_ENTRY, rehydrateLedger } from "./ledger.ts";
import { formatSize, type Frame, type SidekickState } from "./state.ts";

export { FRAME_ENTRY };

/** The message shape `before_agent_start` returns. */
export interface FrameMessage {
	customType: string;
	content: (TextContent | ImageContent)[];
	display: true;
}

/**
 * Build the conversation message that carries a frame.
 *
 * Caption first, then the image: providers read content in order, so the model
 * is told what it is looking at before it looks at it.
 */
export function buildFrameMessage(frame: Frame): FrameMessage {
	return {
		customType: FRAME_ENTRY,
		content: [
			{ type: "text", text: captionFor(frame) },
			{ type: "image", data: frame.data, mimeType: frame.mimeType },
		],
		display: true,
	};
}

/**
 * Wire the hook that moves a frame from the game screen into the conversation.
 */
export function registerAttachment(
	pi: ExtensionAPI,
	state: SidekickState,
	/** Injection point for tests; production always uses the real capture. */
	capture: typeof captureFrame = captureFrame,
): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		await state.ready;
		if (!state.available) return;

		// A conversation can gain a binding at any time — `/gs play` writes the
		// entry into whatever conversation is current, and pi re-runs extensions
		// whenever a conversation is replaced, rebuilding an empty state. Re-read
		// before anything needs a window, or this turn answers "no game bound"
		// for a window that is very much bound.
		//
		// The ledger is re-read here too, for the same reason: a resumed
		// conversation holds its frames as custom messages that pi has already
		// handed to the model, but the counters describing them start at zero.
		const entries = ctx.sessionManager?.getEntries?.();
		const frames = rehydrateLedger(state, entries);
		if (!state.binding) {
			const identity = await restoreBinding(state, entries);
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

		const outcome = await capture(state);
		state.pendingFrame = outcome.ok ? outcome.frame : null;

		if (!outcome.ok) {
			state.framesDropped++;
			state.lastError = describeFailure(outcome.failure);
			// Deliberately no throw and no message: the question still goes
			// through, just without the picture.
			return;
		}

		state.framesAttached++;
		// Metadata entry alongside the image, so `/gs frames` and `/gs status`
		// have a ledger to rehydrate from on the next process.
		pi.appendEntry(FRAME_ENTRY, { ...outcome.frame.record, reason: "prompt" });

		return { message: buildFrameMessage(outcome.frame) };
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
	const frames = `${state.framesCaptured} frame${state.framesCaptured === 1 ? "" : "s"}`;
	return `[SIDEKICK · ${b.identity.exe} · ${size} · ${frames}${stale}]`;
}