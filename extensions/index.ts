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
 *   2. Never block the game. Capture happens after the user pressed Enter,
 *      never on a timer, never in the foreground process's hot path.
 *   3. Never touch the user's disk with pixels. See extensions/attach.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAttachment, statusText } from "./attach.ts";
import { registerCommands } from "./commands.ts";
import { withGamingSection } from "./prompt.ts";
import { createState, resetSessionState, type SidekickState } from "./state.ts";
import { probeCaptureSupport } from "./windowinfo.ts";

/** Diagnostic entry: safe to `appendEntry`, contains no pixel data. */
export const BINDING_ENTRY = "gamer_sidekick_binding";

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
		if (base === event.systemPrompt && includesGamingSection(base)) return;

		return { systemPrompt: withGamingSection(event.systemPrompt, state) };
	});

	// --- session lifecycle ---------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		await state.ready;

		// A session switch invalidates the binding: the new session has no frame
		// ledger and the old window may not be the game the player is now in.
		if (state.sessionSlug !== null) resetSessionState(state);

		ctx.ui.setStatus("gamer-sidekick", statusText(state));

		// Restore an earlier binding from this session's own entries, so a
		// resumed conversation keeps capturing without re-picking the window.
		const restored = await restoreBinding(state, ctx.sessionManager.getEntries?.());
		if (restored) {
			state.binding = restored;
			state.sessionSlug = restored.identity.slug;
			ctx.ui.notify(`Resumed capture for ${restored.identity.exe}.`, "info");
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
	// Deferred import: tools.ts pulls in sharp and screenshot-desktop.
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

interface StoredBinding {
	slug: string;
	exe: string;
	title: string;
	boundAt: string;
}

/**
 * Recover the last binding this session recorded.
 *
 * Only *identity* is restored. The HWND, bounds and display are deliberately
 * re-resolved from a live window enumeration: a handle stored in a session file
 * from three days ago may now belong to an unrelated window, and reusing it
 * would send someone else's screen to a vision model.
 */
async function restoreBinding(
	state: SidekickState,
	entries: unknown,
): Promise<SidekickState["binding"] | null> {
	if (!Array.isArray(entries)) return null;

	let stored: StoredBinding | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: StoredBinding } | undefined;
		if (entry?.type === "custom" && entry.customType === BINDING_ENTRY && entry.data?.slug) {
			stored = entry.data;
			break;
		}
	}
	if (!stored || !state.available) return null;

	const { listWindows, isPickableWindow, resolveDisplays } = await import("./windowinfo.ts");
	const { gameIdentity } = await import("./identity.ts");

	const live = (await listWindows()).filter(isPickableWindow).find((w) => {
		const identity = gameIdentity(w.owner?.path || w.owner?.name || w.title);
		return identity.slug === stored?.slug;
	});
	if (!live) return null;

	const identity = gameIdentity(live.owner?.path || live.owner?.name || live.title);
	const resolved = await resolveDisplays();
	const display = resolved ? pickDisplayFor(resolved.displays, live.bounds) : null;

	return {
		hwnd: live.id,
		identity,
		title: live.title.trim(),
		bounds: live.bounds,
		display: display ?? null,
		boundAt: stored.boundAt,
		follow: false,
		displayOverride: null,
	};
}

function pickDisplayFor<T extends { index: number; x: number; y: number; width: number; height: number }>(
	displays: T[],
	bounds: { x: number; y: number; width: number; height: number },
): T | null {
	const cx = bounds.x + bounds.width / 2;
	const cy = bounds.y + bounds.height / 2;
	for (const d of displays) {
		if (cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) return d;
	}
	return null;
}

export { BINDING_ENTRY as gamerSidekickBindingEntry };
