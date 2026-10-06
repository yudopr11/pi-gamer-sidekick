/**
 * The two model-facing tools. PRD §6.6.2.
 *
 * **A3 turned `game_frame` from a re-sync into the only way to see.** It used to
 * be a way to catch up with a game that had moved on since the frame attached
 * to the message. Now nothing attaches: the package captures when the model
 * calls this tool, and stays silent otherwise. Two things fell out of that
 * worth keeping in mind.
 *
 * First, the description below is load-bearing rather than decorative. A model
 * that does not know *when* to spend a capture will either never call it or call
 * it every turn, and both failures are worse than the behaviour this replaced.
 *
 * Second, this is now the only path that returns an image as a tool result —
 * and pi renders tool results in the terminal. pi's CustomMessageComponent
 * drops the image blocks of a custom message, so the automatic capture reached
 * the model but never the player. Asking for a frame is how the player actually
 * sees one.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { captionFor } from "./frames.ts";
import { selectHistoryFrames } from "./history.ts";
import { describeFailure } from "./attach.ts";
import { FRAME_ENTRY } from "./ledger.ts";
import { formatSize, type SidekickState } from "./state.ts";

interface GameFrameDetails {
	/** Set when no frame could be captured; every other field is then absent. */
	error?: string;
	id?: number;
	exe?: string;
	capturedAt?: string;
	elapsedMs?: number;
	bytes?: number;
	imageTokens?: number;
	/** How the frame was taken — "tool" now that capture is the model's call. */
	reason?: string;
}

/** What the model is told about when it can see the game. One sentence, two modes. */
export function describeMode(state: SidekickState): string {
	if (state.captureMode === "always") {
		return "Every message is being captured automatically, because the player asked for that. A frame arrives with each one; do not call game_frame.";
	}
	return "No frame arrives with a message. You have no view of the game until you call game_frame.";
}

/** Is this tool worth exposing right now? */
async function activeTool(state: SidekickState): Promise<{ active: boolean; reason: string }> {
	await state.ready;
	if (!state.available) {
		// `disabledReason` is null while the probe is still running, so the reason
		// text has to distinguish "switched off" from "not ready yet".
		const why = state.disabledReason ?? "still starting up";
		return { active: false, reason: `screen capture is unavailable on this machine (${why})` };
	}
	// `/gs auto off` puts a frame on every message, so the tool has nothing
	// left to add and is pure cost.
	if (!state.binding) return { active: false, reason: "no game window is bound — run /gs play" };
	return { active: true, reason: "" };
}

export function registerTools(
	pi: ExtensionAPI,
	state: SidekickState,
	// Injectable so the tests can drive the tool without a Windows desktop.
	capture: typeof captureFrame = captureFrame,
): void {
	// --- game_frame ----------------------------------------------------------
	const gameFrame = defineTool({
		name: "game_frame",
		label: "Game Frame",
		description:
			"Take a fresh screenshot of the game window the player is looking at, right now. " +
			"No frame arrives with the message, so this is how you see anything at all. " +
			"Call it when the answer depends on what is on screen right now — what just happened, " +
			"where the player is, what a menu or status screen says, or what changed since the last frame. " +
			"Answer without calling it when the question is about lore, a build, an item recipe, a boss strategy " +
			"or who a character is, or when an earlier frame already answers it. Only works while a game window " +
			"is bound; if it fails, say so and answer from what the player told you. " +
			"Under `/gs auto off` a frame already arrives with every message, so do not call this.",
		promptSnippet: "game_frame: screenshot the player's game window, on demand",
		promptGuidelines: [
			"Call game_frame when your answer depends on what is on screen at this moment — the scene just described, a location, a menu, a status screen, a change since the last frame.",
			"Answer without calling it — the player pays nothing for that turn — when the question is about lore, builds, recipes, strategy or who someone is, or when an earlier frame already answers it.",
			"An earlier frame is a snapshot of an earlier moment. Say \"since the last frame\" or re-check when the game has probably moved on.",
			"If game_frame fails or no window is bound, tell the player and answer from what they said. Never describe a screen you did not see.",
		],
		annotations: { readOnlyHint: true, openWorldHint: false },
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const gate = await activeTool(state);
			if (!gate.active) {
				return {
					content: [{ type: "text", text: `No frame captured: ${gate.reason}.` }],
					details: { error: gate.reason } satisfies GameFrameDetails,
				};
			}

			const historical = state.historyEnabled ? selectHistoryFrames(state.historyFrames) : [];
			const outcome = await capture(state);
			if (!outcome.ok) {
				const reason = describeFailure(outcome.failure);
				// A missing frame is information, not a crash. The model should tell
				// the player why it is answering blind rather than invent an answer.
				return {
					content: [{ type: "text", text: `No frame captured: ${reason}. Answer from what the player told you.` }],
					details: { error: reason } satisfies GameFrameDetails,
				};
			}

			state.framesAttached++;
			const frame = outcome.frame;
			// A tool result is not a conversation message, so nothing else in the
			// transcript describes this frame. Without an entry here the ledger
			// rebuilds from zero on the next process and `/gs frames` forgets it.
			const content = historical.flatMap((snapshot) => [
				{
					type: "text" as const,
					text: captionFor(snapshot)
						.replace("[FRAME #", "[HISTORY #")
						.replace("This is the current game state at the moment you asked.", "This is an earlier game state captured before you asked."),
				},
				{ type: "image" as const, data: snapshot.data, mimeType: snapshot.mimeType },
			]);
			content.push(
				{ type: "text", text: captionFor(frame) },
				{ type: "image", data: frame.data, mimeType: frame.mimeType },
			);
			for (const snapshot of historical) {
				state.framesCaptured++;
				state.frameLog.push(snapshot.record);
				if (state.frameLog.length > 50) state.frameLog.shift();
			}
			state.framesAttached += historical.length;
			pi.appendEntry(FRAME_ENTRY, { ...frame.record, reason: "tool" });
			for (const snapshot of historical) {
				pi.appendEntry(FRAME_ENTRY, { ...snapshot.record, reason: "history" });
			}
			return {
				content,
				details: {
					id: frame.record.id,
					exe: frame.record.exe,
					capturedAt: new Date(frame.record.timestamp).toISOString(),
					elapsedMs: outcome.elapsedMs,
					bytes: frame.record.bytes,
					imageTokens: frame.record.imageTokens,
					reason: "tool",
				} satisfies GameFrameDetails,
			};
		},
	});

	// --- game_window ---------------------------------------------------------
	const gameWindow = defineTool({
		name: "game_window",
		label: "Game Window",
		description:
			"Report which game window is bound to this session, its size, and which frames have been captured. " +
			"Metadata only — returns no pixels.",
		promptSnippet: "game_window: report the bound game window and capture stats",
		annotations: { readOnlyHint: true, openWorldHint: false },
		parameters: Type.Object({}),

		async execute() {
			const b = state.binding;
			if (!state.available || !b) {
				return {
					content: [{ type: "text", text: "No game window is bound. The user runs /gs play to pick one." }],
					details: { bound: false } satisfies GameWindowDetails,
				};
			}
			const details: GameWindowDetails = {
				bound: true,
				exe: b.identity.exe,
				title: b.title,
				hwnd: b.hwnd,
				bounds: b.bounds,
				displayIndex: b.displayOverride ?? b.display?.index ?? 0,
				boundAt: b.boundAt,
				framesCaptured: state.framesCaptured,
			};
			return {
				content: [
					{
						type: "text",
						text:
							`Bound window: ${b.identity.exe} "${b.title}" ${formatSize(b.bounds)} on display ${details.displayIndex}. ` +
							`${state.framesCaptured} frame(s) captured in this conversation. ` +
							`${describeMode(state)}`,
					},
				],
				details,
			};
		},
	});

	pi.registerTool(gameFrame);
	pi.registerTool(gameWindow);

	// Both tools stay registered but leave the active set while no window is
	// bound, so the model is not offered a tool that cannot work. The active set
	// is read-modify-write rather than assigned: other extensions' tools must
	// survive us toggling these two.
	const GS_TOOLS = ["game_frame", "game_window"];
	pi.on("before_agent_start", async () => {
		const gate = await activeTool(state);
		const next = new Set(pi.getActiveTools());
		const before = next.size;
		for (const name of GS_TOOLS) {
			if (gate.active) next.add(name);
			else next.delete(name);
		}
		if (next.size !== before || gate.active) pi.setActiveTools([...next]);
	});
}

interface GameWindowDetails {
	bound: boolean;
	exe?: string;
	title?: string;
	hwnd?: number;
	bounds?: { x: number; y: number; width: number; height: number };
	displayIndex?: number;
	boundAt?: string;
	framesCaptured?: number;
}
