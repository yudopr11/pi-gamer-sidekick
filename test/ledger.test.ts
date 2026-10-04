/**
 * The frame ledger.
 *
 * The bug these cover: after a `/resume`, the conversation still held every
 * frame — as custom messages pi had already handed to the model — while the
 * status line reported "0 frames" and `/gs frames` said none had been
 * captured. The images were accounted for; the bookkeeping was not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { recordFrame, rehydrateLedger } from "../extensions/ledger.ts";
import { createState, type FrameRecord } from "../extensions/state.ts";

function rec(id: number, timestamp = 1_700_000_000_000 + id): FrameRecord {
	return {
		id,
		exe: "sora_2nd.exe",
		width: 1280,
		height: 720,
		bytes: 150_000,
		hash: `hash${String(id).padStart(3, "0")}`,
		timestamp,
		imageTokens: 595,
	};
}

/** A session's entry list as pi would hand it over. */
function entries(...records: FrameRecord[]): unknown[] {
	return records.map((data) => ({ type: "custom", customType: "gamer_sidekick_frame", data }));
}

test("recordFrame counts up and derives framesCaptured from the ledger", () => {
	const state = createState();
	recordFrame(state, rec(1));
	recordFrame(state, rec(2));
	assert.equal(state.frameLog.length, 2);
	assert.equal(state.framesCaptured, 2);
});

test("rehydrate finds frames a resumed conversation already holds", () => {
	const state = createState();
	const found = rehydrateLedger(state, entries(rec(1), rec(2), rec(3)));
	assert.equal(found, 3);
	assert.equal(state.framesCaptured, 3, "the status line must not report 0 for a conversation with frames in it");
	assert.equal(state.frameLog[0]?.id, 1);
	assert.equal(state.frameLog[2]?.id, 3);
});

test("rehydrate preserves the record fields /gs frames prints", () => {
	const state = createState();
	rehydrateLedger(state, entries(rec(7)));
	const r = state.frameLog[0]!;
	assert.equal(r.exe, "sora_2nd.exe");
	assert.equal(r.width, 1280);
	assert.equal(r.imageTokens, 595);
	assert.equal(r.hash, "hash007");
});

test("rehydrate ignores entries that are not frames", () => {
	const state = createState();
	const found = rehydrateLedger(state, [
		{ type: "custom", customType: "gamer_sidekick_binding", data: { slug: "x" } },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: "gamer_sidekick_frame", data: { id: 1 } }, // missing hash/timestamp
		{ type: "custom", customType: "gamer_sidekick_frame" }, // no data at all
	]);
	assert.equal(found, 0);
	assert.equal(state.framesCaptured, 0);
});

test("rehydrate never lets the count go backwards", () => {
	// A live turn takes a frame while the ledger already knows about three from
	// this conversation. The per-turn check must not drag the status back to 3.
	const state = createState();
	rehydrateLedger(state, entries(rec(1), rec(2), rec(3)));
	recordFrame(state, rec(4));
	assert.equal(state.framesCaptured, 4);
	const found = rehydrateLedger(state, entries(rec(1), rec(2)));
	assert.equal(found, 4);
	assert.equal(state.framesCaptured, 4);
});

test("rehydrate is idempotent", () => {
	const state = createState();
	rehydrateLedger(state, entries(rec(1), rec(2)));
	rehydrateLedger(state, entries(rec(1), rec(2)));
	rehydrateLedger(state, entries(rec(1), rec(2)));
	assert.equal(state.frameLog.length, 2, "re-reading the same conversation must not duplicate frames");
	assert.equal(state.framesCaptured, 2);
});

test("rehydrate survives junk", () => {
	const state = createState();
	assert.equal(rehydrateLedger(state, undefined), 0);
	assert.equal(rehydrateLedger(state, null), 0);
	assert.equal(rehydrateLedger(state, "nope"), 0);
	assert.equal(rehydrateLedger(state, [null, undefined, 7, "x"]), 0);
	assert.equal(state.framesCaptured, 0);
});

test("the ledger keeps 50 rows but keeps counting", () => {
	const state = createState();
	for (let i = 1; i <= 60; i++) recordFrame(state, rec(i));
	assert.equal(state.frameLog.length, 50);
	assert.equal(state.framesCaptured, 60, "the total must survive the trim");
	assert.equal(state.frameLog[0]?.id, 11, "the oldest rows are the ones dropped");
	assert.equal(state.frameLog[49]?.id, 60);
});