import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../extensions/commands.ts";
import { sampleHistory, selectHistoryFrames, stopHistory, HISTORY_LIMIT } from "../extensions/history.ts";
import { createState, type Frame, type SidekickState } from "../extensions/state.ts";

function makeFrame(id: number): Frame {
	return {
		record: { id, exe: "game.exe", width: 10, height: 10, bytes: 1, hash: String(id), timestamp: id, imageTokens: 1 },
		data: String(id),
		mimeType: "image/jpeg",
	};
}

function boundState(): SidekickState {
	const state = createState();
	state.available = true;
	state.binding = {
		hwnd: 1,
		identity: { exe: "game.exe", slug: "game", ownerPath: "game.exe" },
		title: "Game",
		bounds: { x: 0, y: 0, width: 10, height: 10 },
		display: null,
		boundAt: new Date().toISOString(),
		displayOverride: null,
	};
	state.historyEnabled = true;
	return state;
}

it("/gs history on starts sampling and off discards sampled frames", async () => {
	const state = boundState();
	state.historyEnabled = false;
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	registerCommands(pi, state);
	const notices: string[] = [];
	const ctx = {
		sessionManager: { getEntries: () => [] },
		ui: { notify: (text: string) => notices.push(text), setStatus() {} },
	} as never;

	await commands.get("gs")?.handler("history on", ctx);
	assert.equal(state.historyEnabled, true);
	assert.ok(state.historyTimer);
	state.historyFrames.push(makeFrame(1));
	await commands.get("gs")?.handler("history off", ctx);
	assert.equal(state.historyEnabled, false);
	assert.equal(state.historyTimer, null);
	assert.deepEqual(state.historyFrames, []);
	assert.match(notices.join(" "), /history is on/);
});

it("samples without adding frames to persistent conversation accounting", async () => {
	const state = boundState();
	const capturedOptions: unknown[] = [];
	await sampleHistory(state, async (_state, options) => {
		capturedOptions.push(options);
		return { ok: true, frame: makeFrame(1), elapsedMs: 2 };
	});
	assert.deepEqual(state.historyFrames.map((frame) => frame.record.id), [1]);
	assert.deepEqual(capturedOptions, [{ record: false }]);
	assert.equal(state.framesCaptured, 0);
	assert.equal(state.frameLog.length, 0);
	assert.equal(state.frames.length, 0);
});

it("caps the rolling history and selects at most three evenly spaced frames", async () => {
	const state = boundState();
	for (let id = 1; id <= HISTORY_LIMIT + 1; id++) {
		await sampleHistory(state, async () => ({ ok: true, frame: makeFrame(id), elapsedMs: 1 }));
	}
	assert.equal(state.historyFrames.length, HISTORY_LIMIT);
	assert.deepEqual(state.historyFrames.slice(0, 1).map((frame) => frame.record.id), [2]);
	assert.deepEqual(selectHistoryFrames(state.historyFrames).map((frame) => frame.record.id), [2, 31, 61]);
});

it("does not mark the replacement binding stale when an old sample finishes", async () => {
	const state = boundState();
	let finishCapture!: (result: { ok: false; failure: { kind: "stale-binding" }; elapsedMs: number }) => void;
	const sampling = sampleHistory(state, () => new Promise((resolve) => { finishCapture = resolve; }));

	stopHistory(state);
	state.binding = { ...state.binding!, hwnd: 2, title: "Other game" };
	state.bindingStale = false;
	finishCapture({ ok: false, failure: { kind: "stale-binding" }, elapsedMs: 1 });
	await sampling;

	assert.equal(state.bindingStale, false);
});

it("discards an in-flight sample when history is stopped", async () => {
	const state = boundState();
	let finishCapture!: (result: { ok: true; frame: Frame; elapsedMs: number }) => void;
	const sampling = sampleHistory(state, () => new Promise((resolve) => { finishCapture = resolve; }));

	stopHistory(state);
	finishCapture({ ok: true, frame: makeFrame(2), elapsedMs: 1 });
	await sampling;

	assert.equal(state.historyEnabled, false);
	assert.deepEqual(state.historyFrames, []);
});

it("discards an in-flight sample from the previous binding after history restarts", async () => {
	const state = boundState();
	let finishCapture!: (result: { ok: true; frame: Frame; elapsedMs: number }) => void;
	const sampling = sampleHistory(state, () => new Promise((resolve) => { finishCapture = resolve; }));

	stopHistory(state);
	state.binding = { ...state.binding!, hwnd: 2, title: "Other game" };
	state.historyEnabled = true;
	finishCapture({ ok: true, frame: makeFrame(2), elapsedMs: 1 });
	await sampling;

	assert.deepEqual(state.historyFrames, []);
});

it("does not return history sampled after game_frame starts", async () => {
	const state = boundState();
	state.historyFrames = [makeFrame(1)];
	let finishCapture!: (result: { ok: true; frame: Frame; elapsedMs: number }) => void;
	const sampling = sampleHistory(state, () => new Promise((resolve) => { finishCapture = resolve; }));

	stopHistory(state);
	finishCapture({ ok: true, frame: makeFrame(2), elapsedMs: 1 });
	await sampling;
	assert.deepEqual(state.historyFrames, []);
});

it("discards history and disables sampling when stopped", async () => {
	const state = boundState();
	state.historyFrames.push(makeFrame(1));
	stopHistory(state);
	await sampleHistory(state, async () => ({ ok: true, frame: makeFrame(2), elapsedMs: 1 }));
	assert.equal(state.historyEnabled, false);
	assert.deepEqual(state.historyFrames, []);
});
