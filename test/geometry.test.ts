import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cropRectFor,
	displayForWindow,
	estimateImageTokens,
	fitLongEdge,
	MAX_LONG_EDGE,
} from "../extensions/geometry.ts";
import { filterWindows, type WindowInfo } from "../extensions/windowinfo.ts";

function win(name: string, title: string, width: number, height: number): WindowInfo {
	return {
		title,
		id: Math.abs(name.length * 7919),
		bounds: { x: 0, y: 0, width, height },
		owner: { name, processId: 1, path: `C:/games/${name}` },
		pid: 1,
		minimized: false,
		maximized: false,
	};
}

const WINDOWS: WindowInfo[] = [
	win("sora_2nd.exe", "Trails in the Sky 2nd Chapter", 2560, 1440),
	win("Nahimic3.exe", "Nahimic", 1680, 798),
	win("eldenring.exe", "ELDEN RING", 2560, 1440),
];

test("filterWindows narrows to a named exe so the picker can be skipped", () => {
	const hits = filterWindows(WINDOWS, "sora_2nd");
	assert.equal(hits.length, 1);
	assert.equal(hits[0]?.owner.name, "sora_2nd.exe");
});

test("filterWindows accepts a name with or without the .exe suffix", () => {
	assert.equal(filterWindows(WINDOWS, "eldenring").length, 1);
	assert.equal(filterWindows(WINDOWS, "eldenring.exe").length, 1);
});

test("filterWindows matches a full path fragment", () => {
	assert.equal(filterWindows(WINDOWS, "games/sora").length, 1);
});

test("filterWindows falls back to the full list when nothing matches", () => {
	// A full picker beats an empty one.
	assert.equal(filterWindows(WINDOWS, "cyberpunk").length, WINDOWS.length);
});

test("filterWindows passes everything through for an empty query", () => {
	assert.equal(filterWindows(WINDOWS, "   ").length, WINDOWS.length);
});

test("scales a 1080p frame down to the long edge", () => {
	assert.deepEqual(fitLongEdge({ width: 1920, height: 1080 }), { width: 1280, height: 720 });
});

test("never upscales a small frame", () => {
	const small = { width: 1280, height: 720 };
	assert.deepEqual(fitLongEdge(small), small);
});

test("handles portrait frames on the long edge", () => {
	assert.deepEqual(fitLongEdge({ width: 1080, height: 1920 }), { width: 720, height: 1280 });
});

test("rounds to at least one pixel", () => {
	const r = fitLongEdge({ width: 10000, height: 3 });
	assert.ok(r.width >= 1 && r.height >= 1);
});

test("crop translates virtual-desktop coords into display-local coords", () => {
	// window at (1920, 0) on a secondary display whose origin is (1920, 0)
	const r = cropRectFor({ x: 1920, y: 0, width: 2560, height: 1440 }, { x: 1920, y: 0, width: 2560, height: 1440 });
	assert.deepEqual(r, { left: 0, top: 0, width: 2560, height: 1440 });
});

test("crop subtracts the display origin", () => {
	const r = cropRectFor({ x: 2000, y: 100, width: 800, height: 600 }, { x: 1920, y: 0, width: 2560, height: 1440 });
	assert.deepEqual(r, { left: 80, top: 100, width: 800, height: 600 });
});

test("crop clamps a window hanging off the display edge", () => {
	const r = cropRectFor({ x: 1800, y: 0, width: 400, height: 200 }, { x: 0, y: 0, width: 1920, height: 1080 });
	assert.deepEqual(r, { left: 1800, top: 0, width: 120, height: 200 });
});

test("crop returns null when the window is entirely off-display", () => {
	assert.equal(cropRectFor({ x: 5000, y: 5000, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }), null);
});

test("crop returns null for a minimized window", () => {
	assert.equal(cropRectFor({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 1920, height: 1080 }), null);
});

test("display is chosen by the window centre point", () => {
	const displays = [
		{ index: 0, x: 0, y: 0, width: 1920, height: 1080 },
		{ index: 1, x: 1920, y: 0, width: 2560, height: 1440 },
	];
	assert.equal(displayForWindow({ x: 1925, y: 100, width: 800, height: 600 }, displays)?.index, 1);
	assert.equal(displayForWindow({ x: 10, y: 10, width: 800, height: 600 }, displays)?.index, 0);
});

test("display is null when the window straddles nothing it centres on", () => {
	assert.equal(displayForWindow({ x: 5000, y: 0, width: 100, height: 100 }, [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }]), null);
});

test("image token estimate uses 512px tiles plus a base", () => {
	// 1280x720 -> 3 x 2 = 6 tiles -> 6*85 + 85
	assert.equal(estimateImageTokens({ width: 1280, height: 720 }), 85 * 6 + 85);
	// a thumbnail is cheap, a 4k frame is not
	assert.ok(estimateImageTokens({ width: 3840, height: 2160 }) > estimateImageTokens({ width: 1280, height: 720 }));
});

test("budget constants match the PRD", () => {
	assert.equal(MAX_LONG_EDGE, 1280);
});
