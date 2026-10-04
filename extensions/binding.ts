/**
 * Binding persistence — PRD §6.1.
 *
 * Separate from index.ts because two callers need it, and they are not the
 * same shape: the extension entry restores at `session_start`, and every turn
 * re-checks lazily (see the note on `restoreBinding`).
 *
 * ## Why a binding can go missing without anything failing
 *
 * Replacing the session re-runs this package's entry function. A brand-new
 * `state` object is built, with `binding: null`, and the closure that ran
 * `/gs play` is now holding a dead object. So anything `/gs play` wrote to
 * state — or to the *previous* session file — is gone, and the status line
 * correctly reports "no game bound" for a window that is very much bound.
 *
 * The binding therefore has to survive in the session file that is current
 * *after* the switch, and something has to read it back. Both halves are here:
 * `appendBinding` writes through the post-switch session manager, and
 * `restoreBinding` re-reads it on every turn until one sticks.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gameIdentity, type GameIdentity } from "./identity.ts";
import type { SidekickState } from "./state.ts";
import { displayFor, isPickableWindow, listWindows, resolveDisplays } from "./windowinfo.ts";

/** Entry type for a stored binding. Contains no pixel data. */
export const BINDING_ENTRY = "gamer_sidekick_binding";

export interface StoredBinding {
	slug: string;
	exe: string;
	title: string;
	boundAt: string;
}

/**
 * `ExtensionContext.sessionManager` is typed `ReadonlySessionManager`, which
 * hides the one method that matters here. `pi.appendEntry` is a one-line
 * delegation to exactly this call — see `appendEntry:(customType,data)=>{...}`
 * in the pi bundle — so going through it directly is the documented path, not
 * a private one. Declared in dist/core/session-manager.d.ts as
 * `appendCustomEntry(customType: string, data?: unknown): string`.
 */
interface EntryWriter {
	appendCustomEntry(customType: string, data?: unknown): string;
}

/**
 * Persist a binding into the session that `ctx` currently belongs to.
 *
 * Called *after* any session replacement, never before: the entry written to
 * the outgoing session is unreachable by the time the switch completes.
 *
 * Returns false when the runtime does not expose the method, so callers can
 * fall back rather than silently lose the binding.
 */
export function appendBinding(ctx: ExtensionContext, data: StoredBinding): boolean {
	const manager = ctx.sessionManager as unknown as Partial<EntryWriter>;
	if (typeof manager.appendCustomEntry !== "function") return false;
	manager.appendCustomEntry(BINDING_ENTRY, data);
	return true;
}

/**
 * Recover the last binding recorded in a session.
 *
 * Only *identity* is restored. The HWND, bounds and display are re-resolved
 * from a live window enumeration: a handle stored in a session file from three
 * days ago may now belong to an unrelated window, and reusing it would send
 * someone else's screen to a vision model.
 *
 * Safe to call repeatedly. It is a pure read plus one window enumeration, and
 * it stops finding anything once a binding is in place, so the per-turn check
 * costs nothing once the player has bound a game.
 */
export async function restoreBinding(state: SidekickState, entries: unknown): Promise<GameIdentity | null> {
	if (!Array.isArray(entries)) return null;

	let stored: StoredBinding | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as
			| { type?: string; customType?: string; data?: StoredBinding }
			| undefined;
		if (entry?.type === "custom" && entry.customType === BINDING_ENTRY && entry.data?.slug) {
			stored = entry.data;
			break;
		}
	}
	if (!stored || !state.available) return null;

	const live = (await listWindows())
		.filter(isPickableWindow)
		.find((w) => gameIdentity(w.owner?.path || w.owner?.name || w.title).slug === stored?.slug);
	if (!live) return null;

	const identity = gameIdentity(live.owner?.path || live.owner?.name || live.title);
	const resolved = await resolveDisplays();
	const display = resolved ? displayFor(resolved.displays, live.bounds) : null;

	state.binding = {
		hwnd: live.id,
		identity,
		title: live.title.trim(),
		bounds: live.bounds,
		display,
		boundAt: stored.boundAt,
		displayOverride: null,
	};
	state.bindingStale = false;
	return identity;
}
