/**
 * Tests for the model-facing tools (PRD §6.6.2).
 *
 * `game_frame` became the capture path in A3: instead of the package attaching
 * a frame to every message, the model decides when the screen matters and asks
 * for one. That makes two things load-bearing that were incidental before —
 * the tool has to tell the model *when* to call it, and a frame taken this way
 * has to leave the same metadata trail behind, because there is no longer a
 * conversation message carrying it for the ledger to rehydrate from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTools } from "../extensions/tools.ts";
import { createState, type Frame, type SidekickState } from "../extensions/state.ts";
import type { CaptureOutcome } from "../extensions/capture.ts";

const JPEG_B64 = Buffer.from("not-really-a-jpeg").toString("base64");

type Block = { type: string; text?: string; data?: string; mimeType?: string };

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: Block[]; details: unknown }>;
}

/** A stub standing in for the real Win32 capture. */
type CaptureStub = (state: SidekickState) => Promise<CaptureOutcome>;

function makeFrame(id: number): Frame {
	return {
		record: {
			id,
			exe: "sora_2nd.exe",
			width: 1280,
			height: 720,
			bytes: 103172,
			hash: "fc0b4ccbf3a4",
			timestamp: 1_700_000_000_000 + id,
			imageTokens: 595,
		},
		data: JPEG_B64,
		mimeType: "image/jpeg",
	};
}

function fakePi() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	const appended: Array<{ type: string; data: unknown }> = [];

	let active = new Set<string>();
	const pi = {
		registerTool(def: RegisteredTool) {
			tools.set(def.name, def);
		},
		on(event: string, handler: (event: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = new Set(names);
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
		ui: { notify() {} },
	} as unknown as ExtensionAPI;

	return {
		pi,
		tools,
		appended,
		activeTools: () => [...active],
		async fire(event: string, payload: unknown) {
			for (const h of handlers.get(event) ?? []) await h(payload);
		},
	};
}

function boundState(): SidekickState {
	const s = createState();
	s.available = true;
	s.ready = Promise.resolve();
	s.binding = {
		hwnd: 1,
		identity: { exe: "sora_2nd.exe", slug: "sora-1", ownerPath: "C:/sora_2nd.exe" },
		title: "Trails in the Sky 2nd Chapter",
		bounds: { x: 0, y: 0, width: 2560, height: 1440 },
		display: { index: 0, x: 0, y: 0, width: 2560, height: 1440 },
		boundAt: new Date().toISOString(),
		displayOverride: null,
	};
	return s;
}

const capturesFrame = (id: number): CaptureStub => async () => ({
	ok: true,
	frame: makeFrame(id),
	elapsedMs: 480,
});

const captureFails: CaptureStub = async () => ({
	ok: false,
	failure: { kind: "black-frame" },
	elapsedMs: 9,
});

/** Register the real tools against a stubbed capture, and hand back the def. */
function setup(state: SidekickState, capture: CaptureStub) {
	const harness = fakePi();
	registerTools(harness.pi, state, capture);
	const tool = harness.tools.get("game_frame");
	assert.ok(tool, "game_frame must be registered");
	return { ...harness, tool };
}

describe("game_frame", () => {
	it("tells the model when to call it and when not to", () => {
		const { tool } = setup(boundState(), capturesFrame(1));

		// A description that does not say *when* turns a decision the model cannot
		// make reliably into a coin flip — and both failure modes are worse than
		// what this replaced. The triggers and the non-triggers both have to be in
		// what the model actually reads, not just in the source.
		const words = `${tool.description} ${(tool.promptGuidelines ?? []).join(" ")}`;
		assert.match(words, /call/i);
		assert.match(words, /screen|window/i);
		assert.match(words, /without calling/i, "must say when NOT to spend a capture");
		assert.ok(tool.promptSnippet, "it has to appear in the available-tools prompt section");
	});

	it("returns the caption and the image, and leaves a metadata trail", async () => {
		const state = boundState();
		const { tool, appended } = setup(state, capturesFrame(1));

		const result = await tool.execute("call-1", {});

		assert.deepEqual(
			result.content.map((c) => c.type),
			["text", "image"],
		);
		const text = result.content[0]?.text ?? "";
		const image = result.content[1] as { data: string; mimeType: string } | undefined;
		assert.match(text, /\[FRAME #001/);
		assert.equal(image?.data, JPEG_B64);
		assert.equal(image?.mimeType, "image/jpeg");

		assert.equal(state.framesAttached, 1);
		// A tool result is not a conversation message, so nothing else in the
		// transcript describes this frame. Without an entry the ledger rebuilds
		// from zero in the next process and `/gs frames` forgets it existed.
		assert.equal(appended.length, 1);
		assert.equal(appended[0]?.type, "gamer_sidekick_frame");
		assert.equal(JSON.stringify(appended[0]?.data).includes(JPEG_B64), false, "no pixels on disk");
		assert.match(JSON.stringify(appended[0]?.data), /"tool"/, "provenance says where it came from");
	});

	it("explains a failure instead of letting the model answer blind", async () => {
		const state = boundState();
		const { tool, appended } = setup(state, captureFails);

		const result = await tool.execute("call-2", {});

		const text = result.content[0]?.text ?? "";
		assert.match(text, /No frame captured/i);
		assert.match(text, /exclusive fullscreen/i);
		assert.equal(appended.length, 0);
		assert.equal(state.framesAttached, 0);
	});

	it("stays out of the active set while no window is bound", async () => {
		const state = createState();
		state.available = true;
		state.ready = Promise.resolve();
		const { pi, fire, activeTools } = fakePi();
		registerTools(pi, state, capturesFrame(1));

		await fire("before_agent_start", { type: "before_agent_start", prompt: "q" });

		// Offering a tool that cannot work is worse than not offering it: the
		// model has to notice the refusal and work around it.
		assert.ok(!activeTools().includes("game_frame"));
		assert.ok(!activeTools().includes("game_window"));
	});

	it("explains the mode it is actually in, so the model knows what it can see", async () => {
		const { pi, tools } = fakePi();
		registerTools(pi, boundState(), capturesFrame(1));

		const onDemand = await tools.get("game_window")?.execute("a", {});
		assert.match(onDemand?.content[0]?.text ?? "", /until you call game_frame/i);

		const always = boundState();
		always.captureMode = "always";
		const { pi: pi2, tools: tools2 } = fakePi();
		registerTools(pi2, always, capturesFrame(1));

		const full = await tools2.get("game_window")?.execute("b", {});
		assert.match(full?.content[0]?.text ?? "", /captured automatically/i);
	});
});

describe("game_window", () => {
	it("reports the bound window as metadata, with no pixels", async () => {
		const { pi, tools } = fakePi();
		registerTools(pi, boundState(), capturesFrame(1));
		const tool = tools.get("game_window");
		assert.ok(tool);

		const result = await tool.execute("call-3", {});

		assert.match(result.content[0]?.text ?? "", /sora_2nd\.exe/);
		assert.ok(
			!result.content.some((c) => c.type === "image"),
			"metadata only",
		);
	});

	it("says plainly that nothing is bound", async () => {
		const state = createState();
		state.available = true;
		state.ready = Promise.resolve();
		const { pi, tools } = fakePi();
		registerTools(pi, state, capturesFrame(1));
		const tool = tools.get("game_window");
		assert.ok(tool);

		const result = await tool.execute("call-4", {});

		const text = result.content[0]?.text ?? "";
		assert.match(text, /no game window is bound/i);
		assert.match(text, /\/gs play/);
	});
});