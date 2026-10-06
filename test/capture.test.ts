import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureFrame } from "../extensions/capture.ts";
import { createState, type Binding, type SidekickState } from "../extensions/state.ts";

const binding: Binding = {
	hwnd: 1,
	identity: { exe: "sora_2nd.exe", slug: "sora-1", ownerPath: "C:/sora_2nd.exe" },
	title: "Trails in the Sky 2nd Chapter",
	bounds: { x: 0, y: 0, width: 2560, height: 1440 },
	display: { index: 0, x: 0, y: 0, width: 2560, height: 1440 },
	boundAt: new Date().toISOString(),
	displayOverride: null,
};

function stateWith(bindingValue: Binding): SidekickState {
	const state = createState();
	state.available = true;
	state.binding = bindingValue;
	return state;
}

describe("captureFrame binding races", () => {
	it("does not mark a replacement binding stale when the old query completes", async () => {
		const state = stateWith(binding);
		state.bindingStale = false;
		let resolveQuery!: (value: null) => void;
		const capture = captureFrame(state, {
			queryWindow: () => new Promise((resolve) => { resolveQuery = resolve; }),
		});
		await new Promise((resolve) => setImmediate(resolve));
		state.binding = { ...binding, hwnd: 2, title: "Other game" };
		resolveQuery(null);

		const result = await capture;
		assert.deepEqual(result.ok && result, false);
		assert.equal(result.ok ? null : result.failure.kind, "stale-binding");
		assert.equal(state.bindingStale, false);
	});
});
