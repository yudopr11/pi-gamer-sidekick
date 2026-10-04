/**
 * The caption the model reads next to a frame image.
 *
 * Frames live in the conversation (see attach.ts), so this text is the only
 * thing standing between the model and a context-less image. It states plainly
 * that this is a screenshot of the game state at the moment the player pressed
 * Enter. Keeping it factual is deliberate — it stops the model narrating a
 * frame it cannot see.
 */

import type { Frame } from "./state.ts";

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