/**
 * Frame pinning and the injection message.
 *
 * The budget is the point of this file (PRD §6.3.3): one live frame plus at
 * most MAX_PINNED_FRAMES carried across turns. A vision model will happily
 * accept fifty screenshots; the user cannot afford that and does not need it.
 */

import { MAX_LIVE_FRAMES, MAX_PINNED_FRAMES } from "./geometry.ts";
import { findFrame, type Frame, type SidekickState } from "./state.ts";

export interface PinResult {
	ok: boolean;
	message: string;
	/** Id of a frame evicted to make room, if any. */
	evicted?: number;
}

/** Pin a frame so it stays in context on every following turn. */
export function pinFrame(state: SidekickState, id?: number): PinResult {
	const target = id ?? state.pendingFrame?.record.id ?? state.frames[state.frames.length - 1]?.record.id;
	if (target === undefined) return { ok: false, message: "No frame has been captured yet." };

	const frame = findFrame(state, target);
	if (!frame) return { ok: false, message: `No frame #${target} in this session.` };

	frame.record.pinned = true;
	state.pinned = state.pinned.filter((p) => p !== target);
	state.pinned.push(target);

	let evicted: number | undefined;
	while (state.pinned.length > MAX_PINNED_FRAMES) {
		const oldest = state.pinned.shift();
		if (oldest === undefined) break;
		const frame = findFrame(state, oldest);
		if (frame) frame.record.pinned = false;
		evicted = oldest;
	}

	return {
		ok: true,
		message: evicted === undefined ? `Pinned frame #${target}.` : `Pinned frame #${target}. Evicted pin #${evicted} (limit ${MAX_PINNED_FRAMES}).`,
		evicted,
	};
}

export function unpinFrame(state: SidekickState, id?: number | "all"): PinResult {
	if (id === "all" || id === undefined) {
		for (const p of state.pinned) findFrame(state, p)!.record.pinned = false;
		const count = state.pinned.length;
		state.pinned = [];
		return { ok: true, message: count === 0 ? "No pins." : `Unpinned ${count} frame(s).` };
	}
	if (!state.pinned.includes(id)) return { ok: false, message: `Frame #${id} is not pinned.` };
	state.pinned = state.pinned.filter((p) => p !== id);
	findFrame(state, id)!.record.pinned = false;
	return { ok: true, message: `Unpinned frame #${id}.` };
}

/** Pinned frames, oldest first. */
export function pinnedFrames(state: SidekickState): Frame[] {
	return state.pinned.map((id) => findFrame(state, id)).filter((f): f is Frame => f !== undefined);
}

/**
 * The caption the model reads next to the image.
 *
 * It states plainly that this is a screenshot of the current game state and
 * carries the provenance the model needs to reason about it. Keeping it
 * factual is deliberate — it stops the model narrating a frame it cannot see.
 */
export function captionFor(frame: Frame): string {
	const r = frame.record;
	const head =
		`[FRAME #${String(r.id).padStart(3, "0")} · ${r.exe} · ${r.width}x${r.height} · captured ${new Date(r.timestamp).toLocaleTimeString()}] ` +
		`This is the current game state at the moment you asked. Describe only what is visible in this frame.`;

	// The model cannot know something was hidden from it, and a frame with a
	// window punched through it invites confident guesses about the gap.
	const covered = r.coveredBy ?? [];
	if (covered.length === 0) return head;
	return (
		`${head} Note: ${covered.join(", ")} was on top of the game when this was captured, ` +
		`so part of the scene is hidden. Say what you can see; do not guess at the rest.`
	);
}

/**
 * Live frames for the turn in flight.
 *
 * The model can pull extra frames with `game_frame` (PRD §6.6.2); this is only
 * the automatic capture taken when the user pressed Enter.
 */
export function liveFrames(state: SidekickState): Frame[] {
	const pending = state.pendingFrame;
	if (!pending) return [];
	return [pending].slice(0, MAX_LIVE_FRAMES);
}
