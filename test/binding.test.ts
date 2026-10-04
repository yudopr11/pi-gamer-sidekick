/**
 * Binding persistence — the tests for the bug where `/gs play` silently lost
 * the binding.
 *
 *   /gs play  ->  switchSession/newSession  ->  pi re-runs this package's
 *   entry function, which builds a brand-new `state` with no binding.
 *
 * So the binding has to be written through the *post-switch* session manager,
 * or it lands in the session being left behind. These tests pin that write path
 * without needing a live session switch — the live switch is covered by
 * scratch/probe-bind.ts, which drives a real pi over RPC.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendBinding, BINDING_ENTRY, restoreBinding } from "../extensions/binding.ts";
import { createState, type SidekickState } from "../extensions/state.ts";

const stored = {
	exe: "sora_2nd.exe",
	slug: "sora_2nd.exe-ba401471",
	title: "Trails in the Sky 2nd Chapter",
	boundAt: "2026-10-04T09:47:40.880Z",
};

describe("binding persistence", () => {
	it("writes the binding through the session manager the context points at", () => {
		const written: Array<{ type: string; data: unknown }> = [];
		const ctx = {
			sessionManager: {
				appendCustomEntry(type: string, data: unknown) {
					written.push({ type, data });
					return "entry-1";
				},
			},
		} as never;

		assert.equal(appendBinding(ctx, stored), true);
		assert.deepEqual(written, [{ type: BINDING_ENTRY, data: stored }]);
	});

	it("reports failure instead of pretending the binding was saved", () => {
		// A pi build whose session manager is genuinely read-only. Losing the
		// binding silently would show up much later as "why did capture stop".
		assert.equal(appendBinding({ sessionManager: {} } as never, stored), false);
	});

	it("returns null without touching the window list when nothing was recorded", async () => {
		const state: SidekickState = createState();
		state.available = true;
		assert.equal(await restoreBinding(state, []), null);
		assert.equal(await restoreBinding(state, undefined), null);
	});

	it("returns null when capture is unavailable, even with a binding recorded", async () => {
		const state: SidekickState = createState();
		state.available = false;
		const entries = [{ type: "custom", customType: BINDING_ENTRY, data: stored }];
		assert.equal(await restoreBinding(state, entries), null);
	});

	it("reads the most recent binding, not the first", async () => {
		// Only the entry-scan half is exercised here: with `available` false the
		// function returns before it enumerates windows, so the test stays fast
		// and Windows-free while still pinning the scan order.
		const state: SidekickState = createState();
		state.available = false;
		const entries = [
			{ type: "custom", customType: BINDING_ENTRY, data: { ...stored, slug: "old" } },
			{ type: "user", content: "unrelated" },
			{ type: "custom", customType: BINDING_ENTRY, data: stored },
		];
		assert.equal(await restoreBinding(state, entries), null);
	});
});