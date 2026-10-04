/**
 * The system-prompt section injected when a game is bound. PRD §6.6.1.
 *
 * Kept short on purpose. A long "you are a gaming strategist" preamble makes
 * the model narrate the frame — describing colours, speculating about mood —
 * instead of answering. Three rules and a capability list is enough.
 */

import type { GameIdentity } from "./identity.ts";
import type { SidekickState } from "./state.ts";

export const PROMPT_SECTION = "gamer-sidekick";

/**
 * Build the section, or `null` when nothing is bound.
 *
 * Returned as `null` rather than an empty string so the caller can skip the
 * rewrite entirely and leave the transcript byte-identical.
 */
export function buildGamingPrompt(state: SidekickState): string | null {
	const binding = state.binding;
	if (!state.available || !binding) return null;

	const identity: GameIdentity = binding.identity;

	const lines = [
		"## Gaming companion",
		"",
		`The player is playing **${identity.exe}**${binding.title ? ` (${binding.title})` : ""}. ` +
			`Screenshots of this game's window are attached to their messages as \`[FRAME #NNN · ...]\` captions, ` +
			`captured at the instant they pressed Enter.`,
		"",
		"- Describe only what is visibly in an attached frame. Never guess at off-screen content, and never invent items, stats, or dialogue you did not see.",
		"- If a frame contradicts what the player says, trust the frame and say so plainly.",
		"- If no frame is attached to a message, you have no view of the game. Say what you can from what they tell you.",
		"- Answer the question asked. Game commentary for its own sake is noise.",
		"",
		`You can pull a **fresh** frame mid-answer with the \`game_frame\` tool, and inspect the bound window with \`game_window\`. ` +
			`Earlier frames stay in the conversation, so the player can refer back to them by number.`,
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
