/**
 * Caption tests — PRD §6.3.
 *
 * The caption is the only thing the model knows about the frame's provenance.
 * Two failure modes matter:
 *
 *   1. No caption, or a caption that does not identify the frame. The model's
 *      reply gets attributed to the wrong turn.
 *   2. A frame with something punched through it, described as if it were
 *      whole. The model cannot see the hole, so it will confidently narrate
 *      whatever it guesses is behind the window that was covering the game.
 *      The caption is the only place that gap can be disclosed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { captionFor } from "../extensions/frames.ts";
import type { Frame, FrameRecord } from "../extensions/state.ts";

function frameWith(overrides: Partial<FrameRecord> = {}): Frame {
	const record: FrameRecord = {
		id: 7,
		exe: "sora_2nd.exe",
		width: 1280,
		height: 720,
		bytes: 132000,
		hash: "17047a0630d0",
		timestamp: 1_700_000_000_000,
		imageTokens: 595,
		...overrides,
	};
	return { record, data: "not-really-base64", mimeType: "image/jpeg" };
}

test("caption identifies the frame by zero-padded id", () => {
	const caption = captionFor(frameWith());
	assert.match(caption, /^\[FRAME #007 · sora_2nd\.exe · 1280x720 · captured /);
});

test("caption names the game so the model can tell one game's frame from another's", () => {
	assert.match(captionFor(frameWith()), /sora_2nd\.exe/);
});

test("caption instructs the model to describe only what it can see", () => {
	assert.match(captionFor(frameWith()), /Describe only what is visible in this frame\./);
});

test("an unobstructed frame carries no caveat", () => {
	assert.doesNotMatch(captionFor(frameWith()), /on top of the game/);
	assert.doesNotMatch(captionFor(frameWith({ coveredBy: [] })), /on top of the game/);
});

test("an occluded frame names the occluder so the model knows the scene is incomplete", () => {
	const caption = captionFor(frameWith({ coveredBy: ["Windows Terminal"] }));
	assert.match(caption, /Windows Terminal was on top of the game/);
	assert.match(caption, /part of the scene is hidden/);
	// The instruction not to guess is the whole point — a hole in a frame reads
	// as content to a vision model, and it will fill it in.
	assert.match(caption, /do not guess at the rest/i);
});

test("multiple occluders are all listed", () => {
	const caption = captionFor(frameWith({ coveredBy: ["Windows Terminal", "Taskbar"] }));
	assert.match(caption, /Windows Terminal, Taskbar was on top/);
});
