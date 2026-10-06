/**
 * Gamer Sidekick — extension entry point.
 *
 * pi package. Attach a screenshot of your game window to whatever you ask.
 *
 *   pi -e ./extensions/index.ts      (development)
 *   pi                                (after `pi install pi-gamer-sidekick`)
 *
 * Design constraints this file enforces, in order of importance:
 *
 *   1. Never crash pi. Every optional native dependency is lazy-loaded and
 *      fails soft, so a machine without a working screen-capture module still
 *      loads the package and can run `/gs setup` to find out why.
 *   2. Never block the game. On-demand capture happens after the user pressed
 *      Enter. Opt-in history samples at 1 fps on a background timer.
 *   3. Never write pixels anywhere the player did not ask for. A frame ends up
 *      in the conversation — which means in the session file — because that is
 *      what makes it survive a `/resume`. See extensions/attach.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAttachment, statusText } from "./attach.ts";
import { appendBinding, restoreBinding } from "./binding.ts";
import { rehydrateLedger } from "./ledger.ts";
import { stopHistory } from "./history.ts";
import { registerCommands } from "./commands.ts";
import { withGamingSection } from "./prompt.ts";
import { createState, type SidekickState } from "./state.ts";
import { colorEnabled, setPaint } from "./style.ts";
import { probeCaptureSupport } from "./windowinfo.ts";

export default function gamerSidekick(pi: ExtensionAPI): void {
	const state: SidekickState = createState();

	// --- availability probe --------------------------------------------------
	// Not awaited at load time — extension loading must not block on a native
	// import. Everything that reads `state.available` awaits `state.ready`
	// instead, so nobody observes the "still starting" state.
	state.ready = probe(state);

	registerCommands(pi, state);
	registerTools(pi, state);
	registerAttachment(pi, state);

	// --- system prompt -------------------------------------------------------
	// Injected at `before_agent_start` rather than `session_start` because that
	// hook hands back the base prompt to rebuild from. Rewriting the prompt on
	// every turn is what keeps the section in sync with the bound window.
	pi.on("before_agent_start", async (event, ctx) => {
		await state.ready;
		if (!state.available || !state.binding) return;

		const base = ctx.getSystemPrompt();
		if (includesGamingSection(base)) return;

		return { systemPrompt: withGamingSection(event.systemPrompt, state) };
	});

	// --- session lifecycle ---------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// Rolling pixels are process/session-local and must not cross conversations.
		stopHistory(state);
		await state.ready;

		// Colour the status line only where a terminal will draw it. `ctx.mode`
		// is authoritative — `process.stdout.isTTY` is the same answer in
		// practice, but it is an inference about stdio wiring rather than a
		// statement of intent from pi.
		setPaint(ctx.mode === "tui" && colorEnabled());

		// No reset here: replacing a conversation re-runs this entry function and
		// builds a fresh state anyway, so there is nothing carried over to clear.
		// Whether a window is bound is decided by this conversation's own
		// binding entry — the player's conversation, their call.
		ctx.ui.setStatus("gamer-sidekick", statusText(state));

		// Restore an earlier binding from this session's own entries, so a
		// resumed conversation keeps capturing without re-picking the window.
		// Same reason for the ledger: the frames are already in this
		// conversation, pi is already feeding them to the model, and the count
		// has to agree with that rather than sit at zero until the next turn.
		const entries = ctx.sessionManager.getEntries?.();
		rehydrateLedger(state, entries);
		if (await restoreBinding(state, entries)) {
			ctx.ui.notify(`Resumed capture for ${state.binding?.identity.exe}.`, "info");
			ctx.ui.setStatus("gamer-sidekick", statusText(state));
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		await state.ready;
		ctx.ui.setStatus("gamer-sidekick", statusText(state));
	});
}

/**
 * Register tools. Kept separate from the entry function so the import graph
 * (and therefore any failure in it) is obvious at a glance.
 */
function registerTools(pi: ExtensionAPI, state: SidekickState): void {
	// Deferred import: tools.ts is the largest module and only matters once a
	// window is bound, so a failure in it must not stop the command surface.
	void import("./tools.ts")
		.then((m) => m.registerTools(pi, state))
		.catch(() => {
			state.available = false;
			state.disabledReason = "tool registration failed";
		});
}

async function probe(state: SidekickState): Promise<void> {
	if (process.platform !== "win32") {
		state.available = false;
		state.disabledReason = `screen capture needs Windows; this is ${process.platform}`;
		return;
	}
	const probe = await probeCaptureSupport();
	state.available = probe.ok;
	state.disabledReason = probe.ok ? null : probe.detail;
}

function includesGamingSection(prompt: string): boolean {
	return prompt.includes("## Gaming companion");
}
