/**
 * End-to-end capture probe. NOT part of the package.
 *
 * Runs the real pipeline (enumerate -> bind -> query -> grab -> scale -> encode)
 * against whatever game window is actually on screen right now, and dumps the
 * resulting JPEG to %TEMP% so it can be eyeballed. Nothing here writes inside
 * the package directory — INV-2 still holds for the product.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureFrame } from "../extensions/capture.ts";
import { gameIdentity } from "../extensions/identity.ts";
import { createState, type Binding } from "../extensions/state.ts";
import { displayFor, listWindows, queryWindow, resolveDisplays, isPickableWindow } from "../extensions/windowinfo.ts";

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(...a);

log("── enumerating windows ──");
const windows = (await listWindows()).filter(isPickableWindow);
for (const w of windows) {
	log(`  ${String(w.id).padStart(10)}  ${w.bounds.width}x${w.bounds.height}  ${w.owner.name}  "${w.title}"`);
}

const target = windows.find((w) => w.owner.name.toLowerCase() === "sora_2nd.exe") ?? windows[0];
if (!target) {
	log("NO TARGET — nothing capturable found");
	process.exit(1);
}
log(`\ntarget: ${target.owner.name} hwnd=${target.id} "${target.title}"`);

log("\n── displays ──");
const displays = await resolveDisplays();
log(`  ${JSON.stringify(displays)}`);

log("\n── targeted query (revalidation path) ──");
const live = await queryWindow(target.id);
log(`  ${JSON.stringify(live)}`);
if (!live) {
	log("QUERY RETURNED NULL — binding would be stale");
	process.exit(1);
}

log("\n── dead hwnd sanity check ──");
log(`  queryWindow(999999999) -> ${JSON.stringify(await queryWindow(999999999))} (expect null)`);

const binding: Binding = {
	hwnd: target.id,
	identity: gameIdentity(target.owner.path),
	title: live.title,
	bounds: live.bounds,
	display: displayFor(displays?.displays ?? [], live.bounds),
	boundAt: new Date().toISOString(),
	displayOverride: null,
};
log(`\nidentity: ${JSON.stringify(binding.identity)}`);

const state = createState();
state.available = true;
state.binding = binding;

log("\n── capturing ──");
const outcome = await captureFrame(state);
if (!outcome.ok) {
	log(`  FAILED: ${JSON.stringify(outcome.failure)}`);
	process.exit(1);
}

const f = outcome.frame;
log(`  ok  ${f.record.width}x${f.record.height}  ${f.record.bytes}b  ~${f.record.imageTokens} tok  ${outcome.elapsedMs}ms`);
log(`  hash ${f.record.hash}`);
log(`  mime ${f.mimeType}`);
log(`  base64 chars ${f.data.length}`);
log(`  state.frames=${state.frames.length} nextId=${state.nextFrameId} captured=${state.framesCaptured}`);

const out = join(tmpdir(), `gs-probe-${Date.now()}.jpg`);
writeFileSync(out, Buffer.from(f.data, "base64"));
log(`  wrote ${out}`);

// Independent verification of what actually landed on disk, reading only the
// header bytes. The point of this probe is that nothing decodes a frame in
// JavaScript any more, so parsing the file back is the only honest check.
const bytes = readFileSync(out);
const soi = bytes[0] === 0xff && bytes[1] === 0xd8;
let dims = "unreadable";
for (let i = 2; i < bytes.length - 9; i++) {
	if (bytes[i] === 0xff && bytes[i + 1] === 0xc0) {
		dims = `${bytes.readUInt16BE(i + 7)}x${bytes.readUInt16BE(i + 5)}`;
		break;
	}
}
log(`\n── decoded image ──`);
log(`  jpeg magic ${soi ? "ok" : "BAD"}  dimensions ${dims}  ${bytes.length} bytes`);

log(`\ntotal ${Date.now() - t0}ms`);