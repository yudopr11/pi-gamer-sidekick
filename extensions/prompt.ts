/**
 * The system-prompt section injected when a game is bound. PRD §6.6.1.
 *
 * Kept short on purpose. A long "you are a gaming strategist" preamble makes
 * the model narrate the frame — describing colours, speculating about mood —
 * instead of answering. Three rules and a capability list is enough.
 *
 * Under A3 this section carries more weight than it used to. It used to
 * describe something that had already happened ("frames are attached to their
 * messages"); now it is the only place the model is told it has to reach for
 * `game_frame` at all, and a model that does not know that answers every
 * question from whatever it can see in the transcript.
 */

import type { GameIdentity } from "./identity.ts";
import type { SidekickState } from "./state.ts";

/**
 * Build the section, or `null` when nothing is bound.
 *
 * Returned as `null` rather than an empty string so the caller can skip the
 * rewrite entirely and leave the transcript byte-identical.
 */
function buildGamingPrompt(state: SidekickState): string | null {
	const binding = state.binding;
	if (!state.available || !binding) return null;

	const identity: GameIdentity = binding.identity;

	const lines = [
		"## Gaming companion",
		"",
		`The player is playing **${identity.exe}**${binding.title ? ` (${binding.title})` : ""}. `,
		"",
		state.alwaysCapture
			? `Every message they send carries a \`[FRAME #NNN · ...]\` screenshot of the game's window, captured at the ` +
					`instant they pressed Enter. You can pull a fresher one mid-answer with \`game_frame\`.`
			: `No screenshot arrives with their messages. You have no view of the game until you call \`game_frame\`, ` +
					`which takes one right now and returns it as an image. Call it whenever the answer depends on what is ` +
					`on screen at this moment — what just happened, where they are, what a menu or status screen says, what ` +
					`changed since the last frame. Answer without it — costing that turn nothing — when the question is ` +
					`about lore, a build, an item recipe, a boss strategy or who a character is, or when an earlier frame in ` +
					`the conversation already answers it. If a question needs a screen and you do not look, you will answer ` +
					`from stale context and be confidently wrong, so when you are unsure whether the screen matters, look.`,
		"",
		"- Describe only what is visibly in a frame you have actually taken. Never guess at off-screen content, and never invent items, stats, or dialogue you did not see.",
		"- If a frame contradicts what the player says, trust the frame and say so plainly.",
		"- If `game_frame` fails, or no window is bound, you have no view of the game. Say so plainly, then answer from what they tell you.",
		"- An earlier frame is a snapshot of an earlier moment. Say \"since the last frame\" or re-check when the game has probably moved on.",
		"- Answer the question asked. Game commentary for its own sake is noise.",
		"",
		`If you have a web search tool, use it for facts about the game that no frame can show — item locations, ` +
			`quest names, boss strategy, party comps, lore, what an error means. Never use it to work out what is on ` +
			`screen: a frame is authoritative for that, and a search will happily return a screenshot of the wrong ` +
			`version of the game. If you have no web tool, say so rather than answering from memory as if it were checked.`,
		"",
		"Frames you take stay in the conversation, so the player can refer back to one by number. " +
			"`game_window` reports the bound window as metadata.",
	];

	return lines.join("\n");
}

/**
 * Wrap the current prompt so it carries the section.
 *
 * pi replaces the whole system prompt from `before_agent_start`, so the base
 * prompt must be threaded through — this is why that hook exposes
 * `systemPromptOptions`. An unlabelled append is the alternative and it makes
 * section replacement impossible; the explicit tag is what pi expects.
 */
export function withGamingSection(basePrompt: string, state: SidekickState): string {
	const section = buildGamingPrompt(state);
	if (!section) return basePrompt;
	return `${basePrompt}\n\n${section}`;
}
