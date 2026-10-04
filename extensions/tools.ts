/**
 * The two model-facing tools. PRD §6.6.2.
 *
 * `game_frame` exists because the automatic capture is a snapshot of the moment
 * the player pressed Enter. By the time the model has thought for four seconds
 * and started asking "what does the minimap show?", the game has moved on. This
 * tool is how it re-synchronises, and it is the only way it sees something the
 * player did not ask about.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { captionFor } from "./frames.ts";
import { describeFailure } from "./attach.ts";
import type { SidekickState } from "./state.ts";

interface GameFrameDetails {
	/** Set when no frame could be captured; every other field is then absent. */
	error?: string;
	id?: number;
	exe?: string;
	capturedAt?: string;
	elapsedMs?: number;
	bytes?: number;
	imageTokens?: number;
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
	if (!state.binding) return { active: false, reason: "no game window is bound — run /gs play" };
	return { active: true, reason: "" };
}

export function registerTools(pi: ExtensionAPI, state: SidekickState): void {
	// --- game_frame ----------------------------------------------------------
	const gameFrame = defineTool({
		name: "game_frame",
		label: "Game Frame",
		description:
			"Grab a fresh screenshot of the bound game window right now. Use this when the player asks about something " +
			"the automatic capture may have missed, or when you need to re-synchronise with the current game state. " +
			"Only works while a game window is bound.",
		promptSnippet: "game_frame: grab a fresh screenshot of the bound game window",
		promptGuidelines: [
			"Prefer the automatically attached frame over calling game_frame — call it when the attached frame is stale or you need to look at something the player did not ask about.",
		],
		annotations: { readOnlyHint: true, openWorldHint: false },
		parameters: Type.Object({
			reason: Type.Optional(
				Type.String({
					description: "Why you are grabbing this frame. Appears in the capture log.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gate = await activeTool(state);
			if (!gate.active) {
				return {
					content: [{ type: "text", text: `No frame captured: ${gate.reason}.` }],
					details: { error: gate.reason } satisfies GameFrameDetails,
				};
			}

			const outcome = await captureFrame(state, params.reason ?? "model requested");
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
			return {
				content: [
					{ type: "text", text: captionFor(frame) },
					{ type: "image", data: frame.data, mimeType: frame.mimeType },
				],
				details: {
					id: frame.record.id,
					exe: frame.record.exe,
					capturedAt: new Date(frame.record.timestamp).toISOString(),
					elapsedMs: outcome.elapsedMs,
					bytes: frame.record.bytes,
					imageTokens: frame.record.imageTokens,
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
							`Bound window: ${b.identity.exe} "${b.title}" ${b.bounds.width}x${b.bounds.height} on display ${details.displayIndex}. ` +
							`${state.framesCaptured} frame(s) captured this session.`,
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
