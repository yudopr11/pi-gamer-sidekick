/**
 * Tests for the frame attachment hooks — the load-bearing mechanism (PRD G-D4).
 *
 * Two invariants carry the whole design and are asserted here:
 *
 *   1. No image bytes are ever persisted. `before_agent_start` appends metadata
 *      only; the JPEG reaches the model exclusively through the `context`
 *      handler, which pi applies request-locally and then discards. (INV-2)
 *   2. The `context` handler runs before EVERY provider call in a turn, so it
 *      must be idempotent — re-injecting would duplicate the image and multiply
 *      token cost on every follow-up call.
 *
 * The capture step is injected so these tests need neither Windows nor a game.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildFrameMessage, hasFrameCaption, registerAttachment } from "../extensions/attach.ts";
import { createState, type Frame, type SidekickState } from "../extensions/state.ts";
import type { CaptureOutcome } from "../extensions/capture.ts";

const JPEG_B64 = Buffer.from("not-really-a-jpeg").toString("base64");

function makeFrame(id: number, pinned = false): Frame {
	return {
		record: {
			id,
			exe: "sora_2nd.exe",
			width: 1280,
			height: 720,
			bytes: 103172,
			hash: "fc0b4ccbf3a4",
			timestamp: 1_700_000_000_000 + id,
			pinned,
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
	s.binding = {
		hwnd: 1,
		identity: { exe: "sora_2nd.exe", slug: "sora-1", sessionName: "gamer-sidekick/sora-1", ownerPath: "C:/sora_2nd.exe" },
		title: "Trails in the Sky 2nd Chapter",
		bounds: { x: 0, y: 0, width: 2560, height: 1440 },
		display: { index: 0, x: 0, y: 0, width: 2560, height: 1440 },
		boundAt: new Date().toISOString(),
		follow: false,
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

	it("injects the frame into the request at the context event", async () => {
		const state = boundState();
		const { pi, fire } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(1)));

		await fire("before_agent_start", { type: "before_agent_start", prompt: "who is that?" });
		const [result] = await fire("context", {
			type: "context",
			messages: [{ role: "user", content: "who is that?", timestamp: 1 }],
		});

		const messages = (result as { messages: unknown[] }).messages;
		// The live frame is appended AFTER the question, so the model reads the
		// ask first and the pixels second.
		assert.equal(messages.length, 2);
		assert.deepEqual(messages[0], { role: "user", content: "who is that?", timestamp: 1 });

		const injected = messages[1] as { role: string; content: (Record<string, string>)[] };
		assert.equal(injected.role, "user");
		assert.deepEqual(
			injected.content.map((c) => c.type),
			["text", "image"],
		);
		// Caption first, then pixels — providers read content in order.
		const [text, image] = injected.content as [{ text: string }, { data: string; mimeType: string }];
		assert.match(text.text, /\[FRAME #001/);
		assert.match(text.text, /sora_2nd\.exe/);
		assert.equal(image.data, JPEG_B64);
		assert.equal(image.mimeType, "image/jpeg");
	});

	it("is idempotent across the repeated context calls of one turn", async () => {
		const state = boundState();
		const { pi, fire } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(1)));

		await fire("before_agent_start", { type: "before_agent_start", prompt: "q" });

		const payload = {
			type: "context",
			messages: [{ role: "user", content: "q", timestamp: 1 }],
		};
		const first = (await fire("context", payload))[0] as { messages: unknown[] };
		// Second provider call in the same turn carries what the first returned.
		const second = (await fire("context", { type: "context", messages: first.messages }))[0] as {
			messages: unknown[];
		};

		assert.equal(first.messages.length, 2);
		assert.equal(second, undefined, "already-injected frame must not be injected again");
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

	it("places pinned frames at the head and the live frame at the tail", async () => {
		const state = boundState();
		const { pi, fire } = fakePi();
		registerAttachment(pi, state, async () => okCapture(makeFrame(2)));

		state.frames.push(makeFrame(1, true));
		state.pinned.push(1);

		await fire("before_agent_start", { type: "before_agent_start", prompt: "compare" });
		const [result] = await fire("context", {
			type: "context",
			messages: [{ role: "user", content: "compare", timestamp: 1 }],
		});

		const messages = (result as { messages: unknown[] }).messages;
		assert.equal(messages.length, 3);
		const first = (messages[0] as { content: { text: string }[] }).content[0] as { text: string };
		const last = (messages[2] as { content: { text: string }[] }).content[0] as { text: string };
		assert.match(first.text, /#001/, "the 'before' reference comes before the question");
		assert.match(last.text, /#002/, "the current frame comes after the question");
	});
});

describe("hasFrameCaption", () => {
	it("matches on the padded caption needle", () => {
		assert.equal(hasFrameCaption([buildFrameMessage(makeFrame(7), 0)], 7), true);
		assert.equal(
			hasFrameCaption([{ role: "user", content: "see [FRAME #007 · sora_2nd.exe]", timestamp: 0 }], 7),
			true,
		);
	});

	it("does not match a different frame or a non-user message", () => {
		assert.equal(hasFrameCaption([{ role: "user", content: "[FRAME #008 · x]", timestamp: 0 }], 7), false);
		assert.equal(hasFrameCaption([{ role: "assistant", content: "[FRAME #007 · x]", timestamp: 0 }], 7), false);
		assert.equal(hasFrameCaption([], 7), false);
	});
});