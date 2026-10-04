/**
 * The frame ledger.
 *
 * ## The problem this solves
 *
 * `state` is rebuilt from scratch every time the conversation is replaced, and
 * on every fresh process. The *frames* are not rebuilt, because they live in
 * the session file as `custom_message` entries and pi hands them straight back
 * to the model. But the counters that describe them start at zero — so after a
 * `/resume` the status line cheerfully reports "0 frames" for a conversation
 * with twenty frames in it, and `/gs frames` says none have been captured.
 *
 * The images are already accounted for; only the bookkeeping was missing. This
 * module re-reads the metadata entries and rebuilds the count. No pixel data
 * is loaded: the ledger is `FrameRecord` rows, a couple of hundred bytes each,
 * while the frames themselves are ~150 KB apiece and pi has those.
 *
 * Deliberately separate from `state.frames`, which holds live `Frame` objects
 * with their base64 and is pruned to 8. The ledger is metadata only and keeps
 * 50, because it has to describe frames captured in an earlier process.
 */

import type { FrameRecord, SidekickState } from "./state.ts";

/** Matches the custom message / entry type frames are stored under. */
export const FRAME_ENTRY = "gamer_sidekick_frame";

/** Ledger size. Older rows fall off the top; the count keeps rising. */
const LEDGER_LIMIT = 50;

function isFrameRecord(value: unknown): value is FrameRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<FrameRecord>;
	return typeof r.id === "number" && typeof r.hash === "string" && typeof r.timestamp === "number";
}

/**
 * Record a captured frame in the ledger.
 *
 * `framesCaptured` is the conversation's true total and never comes down —
 * trimming the listing must not quietly lower the number in the status line.
 * `frameLog` is the listing, capped at 50.
 */
export function recordFrame(state: SidekickState, record: FrameRecord): void {
	state.framesCaptured++;
	state.frameLog.push(record);
	while (state.frameLog.length > LEDGER_LIMIT) state.frameLog.shift();
}

/**
 * Rebuild the ledger from a conversation's entries.
 *
 * Safe to call repeatedly and cheap once it has run — it does nothing if the
 * ledger is already at least as long as what the conversation holds, which is
 * the normal case on a live turn. Returns the number of frames found.
 *
 * Idempotent by construction: it replaces the ledger rather than appending to
 * it, so a resumed conversation reports its real frame count and a live one
 * keeps counting up from there.
 */
export function rehydrateLedger(state: SidekickState, entries: unknown): number {
	if (!Array.isArray(entries)) return state.framesCaptured;

	const found: FrameRecord[] = [];
	for (const entry of entries as { type?: string; customType?: string; data?: unknown }[]) {
		if (entry?.type === "custom" && entry.customType === FRAME_ENTRY && isFrameRecord(entry.data)) {
			found.push(entry.data);
		}
	}
	if (found.length === 0) return state.framesCaptured;

	// Only accept the rebuild if it knows about more frames than we do;
	// otherwise a conversation that has been compacted or branched would make
	// the count go backwards under the player's feet. The total only ever
	// rises; the listing is replaced wholesale.
	if (found.length <= state.framesCaptured) return state.frameLog.length;

	state.frameLog = found.slice(-LEDGER_LIMIT);
	state.framesCaptured = found.length;
	return found.length;
}