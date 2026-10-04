/**
 * End-to-end capture probe. NOT part of the package.
 *
 * Runs the real pipeline (enumerate -> bind -> query -> grab -> crop -> scale ->
 * encode) against whatever game window is actually on screen right now, and
 * dumps the resulting JPEG to %TEMP% so it can be eyeballed. Nothing here
 * writes inside the package directory — INV-2 still holds for the product.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { captureFrame } from "../extensions/capture.ts";
import { gameIdentity } from "../extensions/identity.ts";
import { createState, type Binding } from "../extensions/state.ts";
import { listWindows, queryWindow, resolveDisplays, isPickableWindow } from "../extensions/windowinfo.ts";

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
	display: displays?.displays.find((d) => d.index === live.displayIndex) ?? displays?.displays[0] ?? null,
	boundAt: new Date().toISOString(),
	follow: false,
	displayOverride: null,
};
log(`\nidentity: ${JSON.stringify(binding.identity)}`);

const state = createState();
state.available = true;
state.binding = binding;

log("\n── capturing ──");
const outcome = await captureFrame(state, "probe");
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

// Independent verification of what actually landed on disk.
const meta = await sharp(out).stats();
log(`\n── decoded image stats ──`);
log(`  channels ${meta.channels.length} mean ${meta.channels.map((c) => c.mean.toFixed(1)).join("/")}`);
log(`  entropy ${meta.entropy.toFixed(3)} isOpaque ${meta.isOpaque}`);

log(`\ntotal ${Date.now() - t0}ms`);