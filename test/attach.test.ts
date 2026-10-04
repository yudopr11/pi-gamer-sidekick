/**
 * Tests for the frame attachment hook — the load-bearing mechanism (PRD §6.3.2,
 * amendment A2).
 *
 * The frame is returned from `before_agent_start` as a custom message, which is
 * what puts it in the normal conversation: pi appends it after the player's
 * question, converts it to a user message for the provider, persists it, and
 * renders it. So the two things worth asserting are that the returned message
 * carries the image, and that the metadata entry beside it does not.
 *
 * The capture step is injected so these tests need neither Windows nor a game.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildFrameMessage, registerAttachment } from "../extensions/attach.ts";
import { createState, type Frame, type SidekickState } from "../extensions/state.ts";
import type { CaptureOutcome } from "../extensions/capture.ts";

const JPEG_B64 = Buffer.from("not-really-a-jpeg").toString("base64");

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

/** Minimal stand-in for the parts of ExtensionAPI these hooks touch. */
function fakePi() {
	const handlers = new Map<string, Array<(e: never, c: never) => unknown>>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const notified: string[] = [];

	const pi = {
		on(event: string, handler: (e: never, c: never) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
		ui: {
			notify(msg: string) {
				notified.push(msg);
			},
		},
	} as unknown as ExtensionAPI;

	const fire = async (event: string, payload: unknown) => {
		const results: unknown[] = [];
		for (const h of handlers.get(event) ?? []) {
			results.push(await (h as (e: unknown, c: unknown) => unknown)(payload, pi));
		}
		return results;
	};

	return { pi, fire, appended, notified };
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

const okCapture = (frame: Frame): CaptureOutcome => ({ ok: true, frame, elapsedMs: 480 });
const failCapture = (kind: "minimized" | "black-frame"): CaptureOutcome => ({
	ok: false,
	failure: { kind },
	elapsedMs: 12,
});

describe("frame attachment", () => {
	it("captures on submit and appends metadata only", async () => {
		const state = boundState();
		const { pi, fire, appended } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(1)));

		await fire("before_agent_start", { type: "before_agent_start", prompt: "what do you see?" });

		assert.equal(state.framesAttached, 1);
		assert.equal(state.pendingFrame?.record.id, 1);

		assert.equal(appended.length, 1);
		assert.equal(appended[0]?.type, "gamer_sidekick_frame");
		// The critical assertion: provenance, not pixels.
		assert.equal("data" in (appended[0]?.data as object), false);
		assert.equal(JSON.stringify(appended[0]?.data).includes(JPEG_B64), false);
	});

	it("returns the frame as a conversation message", async () => {
		const state = boundState();
		const { pi, fire } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(1)));

		const [result] = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "who is that?",
		});

		// pi pushes this onto the conversation right after the question.
		const message = (result as { message?: { customType: string; content: Record<string, string>[] } }).message;
		assert.ok(message, "the turn must get a frame message");
		assert.equal(message?.customType, "gamer_sidekick_frame");
		assert.deepEqual(
			message?.content.map((c) => c.type),
			["text", "image"],
		);
		// Caption first, then pixels — providers read content in order.
		const [text, image] = message?.content as [{ text: string }, { data: string; mimeType: string }];
		assert.match(text.text, /\[FRAME #001/);
		assert.match(text.text, /sora_2nd\.exe/);
		assert.equal(image.data, JPEG_B64);
		assert.equal(image.mimeType, "image/jpeg");
	});

	it("builds a displayable message so the player sees the frame", () => {
		const message = buildFrameMessage(makeFrame(3));
		assert.equal(message.display, true);
		assert.equal(message.content.length, 2);
	});

	it("waits for the startup probe before deciding to stay silent", async () => {
		// Regression: the probe is fire-and-forget, so a command typed straight
		// after launch used to see available:false / reason:null and report the
		// package as switched off when it was only still starting up.
		const state = createState();
		const { pi, fire, appended } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(1)));

		let release!: () => void;
		state.ready = new Promise<void>((r) => (release = r));
		state.binding = boundState().binding;

		const pending = fire("before_agent_start", { type: "before_agent_start", prompt: "q" });
		assert.equal(appended.length, 0, "must not capture while the probe is still running");

		state.available = true;
		release();
		await pending;

		assert.equal(appended.length, 1, "the turn still captures once the probe resolves");
	});

	it("never blocks the turn when capture fails", async () => {
		const state = boundState();
		const { pi, fire, appended } = fakePi();
		registerAttachment(pi, state, async () => failCapture("black-frame"));

		await fire("before_agent_start", { type: "before_agent_start", prompt: "q" });

		assert.equal(state.framesAttached, 0);
		assert.equal(state.framesDropped, 1);
		assert.match(state.lastError ?? "", /exclusive fullscreen/);
		assert.equal(appended.length, 0);
		assert.equal(state.pendingFrame, null);
	});

	it("hints once, then stays quiet, when no window is bound", async () => {
		const state = createState();
		state.available = true;
		state.ready = Promise.resolve();
		const { pi, fire, notified } = fakePi();
		let called = 0;
		registerAttachment(pi, state, async () => {
			called++;
			return okCapture(makeFrame(1));
		});

		await fire("before_agent_start", { type: "before_agent_start", prompt: "a" });
		await fire("before_agent_start", { type: "before_agent_start", prompt: "b" });

		assert.equal(called, 0, "must not attempt a capture with nothing bound");
		assert.equal(notified.length, 1);
		assert.match(notified[0] ?? "", /\/gs play/);
	});

	it("keeps capturing once a window is bound", async () => {
		const state = boundState();
		const { pi, fire } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(2)));

		await fire("before_agent_start", { type: "before_agent_start", prompt: "compare" });
		const [result] = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "and now?",
		});

		// One capture per turn, and the new frame is the one that ships. Frames
		// already in the conversation need no re-injection.
		assert.equal(state.framesAttached, 2);
		const message = (result as { message?: { content: { text: string }[] } }).message;
		assert.match(message?.content[0]?.text ?? "", /#002/);
	});
});
