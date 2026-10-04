/**
 * Frame attachment — the load-bearing mechanism of this package.
 *
 * PRD §6.3.2, amended by A2 and then reversed by A3.
 *
 * **A3: the model asks for frames, the package does not volunteer them.**
 * A2 captured on every message and appended the frame to the conversation.
 * That made a question about lore, a boss or a build cost ~150 KB of session
 * file and ~595 image tokens for a picture of an unchanging room. So the
 * capture now happens inside `game_frame`, and this hook only does two things:
 * re-read the binding and the ledger before the turn, and — when the player
 * has asked for it with `/gs auto on` — capture the old way.
 *
 * The reasons it is safe to invert rather than guess at:
 *
 *   - **The model is the only one who knows.** Whether a question depends on
 *     the screen is a property of the question. A keyword match in here would
 *     be a guess with no way to recover from a false negative: the model has no
 *     idea it is flying blind.
 *   - **It is cheaper in the common case.** A turn that does not need a frame
 *     now costs nothing at all — no capture, no tokens, no disk, no ~600 ms.
 *   - **It fixes the rendering gap.** pi's CustomMessageComponent shows the
 *     text blocks of a custom message and drops the image, so a frame attached
 *     this way reached the model but never the player. A tool result *is*
 *     rendered, so asking for a frame is the first path where you see the
 *     picture in the terminal.
 *
 * The cost is a round trip on the turns that do need one, and the model's
 * willingness to reach for the tool. `/gs auto on` is the escape hatch for
 * either objection; `/gs status` and the footer show which mode is in force.
 *
 * **Why the ledger re-read stays on this hook.** A conversation can gain a
 * binding at any time, and pi rebuilds the extension — and this state — whenever
 * a conversation is replaced. This hook runs before every turn, so it is the
 * one place that can put a resumed conversation back together before the model
 * decides whether it needs to look at anything.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { bold, dim, green, red, underline, yellow } from "./style.ts";
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
 * Only used when `/gs auto on` has put capture back on every message; on the
 * default path the frame rides home as a `game_frame` tool result instead.
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

		// Default path: the model calls `game_frame` if it needs to see. Nothing
		// is captured, nothing is attached, and the turn is indistinguishable
		// from one with no game bound at all — which is the cost the player was
		// asking to avoid. `/gs auto off` opts back into the old behaviour.
		if (state.captureMode !== "always") {
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

/**
 * The footer status line. PRD §6.6.3.
 *
 * Designed to be read at a glance without focusing on it. Three rules:
 *
 * 1. **A glyph carries the state.** `●` bound and healthy, `○` nothing bound or
 *    still starting, `×` broken. That is the one thing worth parsing, and it
 *    survives being truncated.
 * 2. **Weight, not spacing, sets the hierarchy.** pi's `sanitizeStatusText`
 *    collapses runs of spaces, so double spaces do not survive — a design that
 *    leans on them renders differently from the one that was written. The
 *    wordmark and separators recede with `dim`; the bound executable is the
 *    only bold thing on the line.
 * 3. **Say nothing that is not true.** No frame counter until there is a frame
 *    to count — an empty `0 frames` is noise that costs eight characters.
 *
 * The wordmark is set as `Sidekick`. Caps are the terminal's shouting
 * convention, meant for something that needs to cut through, and this line is
 * dimmed and sits beside other packages' status — so it takes an initial cap as
 * a proper noun and nothing more.
 *
 * Every space here is single, deliberately: that is what pi actually renders.
 */
export function statusText(state: SidekickState): string | undefined {
	if (!state.available) {
		if (state.disabledReason) return `${red("×")} ${dim("Sidekick")} ${red(state.disabledReason)}`;
		return `${dim("○")} ${dim("Sidekick")} starting…`;
	}
	if (!state.binding) {
		return `${yellow("○")} ${dim("Sidekick")} no window ${dim("·")} ${underline("/gs play")}`;
	}

	const b = state.binding;
	const size = formatSize({ width: b.bounds.width, height: b.bounds.height });
	const parts = [
		`${state.bindingStale ? yellow("●") : green("●")} ${dim("Sidekick")} ${bold(b.identity.exe)} ${dim("·")} ${size}`,
	];
	if (state.framesCaptured > 0) {
		parts.push(`${dim("·")} ${state.framesCaptured} frame${state.framesCaptured === 1 ? "" : "s"}`);
	}
	// Always-on is a mode the player set deliberately and will notice its
	// absence when it stops being what they want, so say which one is in force.
	if (state.captureMode === "always") parts.push(`${dim("·")} every message`);
	if (state.bindingStale) parts.push(`${dim("·")} ${yellow("stale")}`);
	return parts.join(" ");
}