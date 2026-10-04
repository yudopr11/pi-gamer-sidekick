/**
 * Tests for the footer status line.
 *
 * Two things are worth pinning down. First, the *words*: the line is read
 * without focusing, so the state glyph has to be the one thing that always
 * parses, and an empty "0 frames" must not appear. Second, the escape codes
 * have to survive pi's `sanitizeStatusText` (which only rewrites `\r`, `\n`,
 * `\t` and collapses runs of spaces) and be absent when nothing is watching.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { statusText } from "../extensions/attach.ts";
import { colorEnabled, setPaint } from "../extensions/style.ts";
import { createState, type Binding, type SidekickState } from "../extensions/state.ts";

const BINDING: Binding = {
	hwnd: 526900,
	title: "Trails in the Sky 2nd Chapter",
	bounds: { x: 0, y: 0, width: 2560, height: 1440 },
	display: null,
	displayOverride: null,
	identity: {
		exe: "sora_2nd.exe",
		slug: "sora_2nd.exe-ba401471",
		ownerPath: "D:\\Games\\SteamLibrary\\steamapps\\common\\Trails in the Sky 2nd Chapter\\sora_2nd.exe",
	},
	boundAt: "2026-10-04T09:12:28.590Z",
};

/**
 * `createState()` starts unavailable, because the capture probe has not run
 * yet. Every state line worth asserting about other than "starting" needs it
 * past that point.
 */
function stateWith(overrides: Partial<SidekickState> = {}): SidekickState {
	return { ...createState(), available: true, ...overrides };
}

/** Run `body` with a specific colour environment, restoring whatever was there. */
function withColor(env: { NO_COLOR?: string; FORCE_COLOR?: string }, body: () => void): void {
	const before = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		body();
	} finally {
		for (const [k, v] of Object.entries(before)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const ANY_ESC = /\x1b\[[0-9;]*m/;
const ALL_ESC = /\x1b\[[0-9;]*m/g;

describe("status line — words", () => {
	it("says what to do when nothing is bound", () => {
		const line = statusText(stateWith()) ?? "";
		assert.match(line, /no window/);
		assert.match(line, /\/gs play/);
	});

	it("does not mention a frame count before there is a frame", () => {
		const line = statusText(stateWith({ binding: BINDING })) ?? "";
		assert.doesNotMatch(line, /frame/);
	});

	it("counts frames once there are some, and pluralises", () => {
		const one = statusText(stateWith({ binding: BINDING, framesCaptured: 1 })) ?? "";
		assert.match(one, /1 frame(?!s)/);
		const three = statusText(stateWith({ binding: BINDING, framesCaptured: 3 })) ?? "";
		assert.match(three, /3 frames/);
	});

	it("marks a stale binding instead of hiding it", () => {
		const line = statusText(stateWith({ binding: BINDING, bindingStale: true })) ?? "";
		assert.match(line, /stale/);
	});

	it("gives a reason when capture is unavailable", () => {
		const line = statusText(stateWith({ available: false, disabledReason: "no window found" })) ?? "";
		assert.match(line, /no window found/);
		assert.doesNotMatch(line, /starting/);
	});

	it("distinguishes still-starting from broken", () => {
		const starting = statusText(stateWith({ available: false, disabledReason: null })) ?? "";
		const broken = statusText(stateWith({ available: false, disabledReason: "no window found" })) ?? "";
		assert.match(starting, /starting/);
		assert.notEqual(starting, broken);
	});

	it("uses a lowercase wordmark, not a shouting one", () => {
		for (const state of [
			stateWith(),
			stateWith({ binding: BINDING }),
			stateWith({ binding: BINDING, framesCaptured: 3, bindingStale: true }),
			stateWith({ available: false, disabledReason: null }),
			stateWith({ available: false, disabledReason: "boom" }),
		]) {
			const line = statusText(state) ?? "";
			assert.match(line, /\bsidekick\b/);
			assert.doesNotMatch(line, /SIDEKICK/);
		}
	});

	it("uses a multiplication sign, not an x, for dimensions", () => {
		const line = statusText(stateWith({ binding: BINDING })) ?? "";
		assert.match(line, /2560×1440/);
	});

	it("puts the executable in bold so it is the only thing that reads as bold", () => {
		withColor({ FORCE_COLOR: "1", NO_COLOR: "" }, () => {
			const line = statusText(stateWith({ binding: BINDING })) ?? "";
			const bolded = line.match(/\x1b\[1m(\S+)\x1b\[0m/g) ?? [];
			assert.equal(bolded.length, 1);
			assert.match(bolded[0] ?? "", /sora_2nd\.exe/);
		});
	});
});

describe("status line — colour", () => {
	it("emits no escape codes when NO_COLOR is set, even with FORCE_COLOR", () => {
		withColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, () => {
			for (const state of [
				stateWith(),
				stateWith({ binding: BINDING, framesCaptured: 3 }),
				stateWith({ binding: BINDING, bindingStale: true }),
				stateWith({ available: false, disabledReason: "boom" }),
			]) {
				assert.doesNotMatch(statusText(state) ?? "", ANY_ESC);
			}
		});
	});

	it("emits no escape codes when stdout is not a TTY", () => {
		withColor({ NO_COLOR: "", FORCE_COLOR: "" }, () => {
			assert.equal(process.stdout.isTTY, undefined, "test assumes a piped stdout");
			assert.doesNotMatch(statusText(stateWith({ binding: BINDING })) ?? "", ANY_ESC);
		});
	});

	it("colours the glyph by state: green bound, yellow unbound, red broken", () => {
		withColor({ NO_COLOR: "", FORCE_COLOR: "1" }, () => {
			assert.match(statusText(stateWith({ binding: BINDING })) ?? "", /^\x1b\[32m●/);
			assert.match(statusText(stateWith()) ?? "", /^\x1b\[33m○/);
			assert.match(statusText(stateWith({ available: false, disabledReason: "boom" })) ?? "", /^\x1b\[31m×/);
		});
	});

	it("warns in yellow rather than green when the binding has gone stale", () => {
		withColor({ NO_COLOR: "", FORCE_COLOR: "1" }, () => {
			assert.match(statusText(stateWith({ binding: BINDING, bindingStale: true })) ?? "", /^\x1b\[33m●/);
		});
	});

	it("renders identically to what pi's sanitizer leaves behind", () => {
		withColor({ NO_COLOR: "", FORCE_COLOR: "" }, () => {
			const cases: SidekickState[] = [
				stateWith(),
				stateWith({ binding: BINDING }),
				stateWith({ binding: BINDING, framesCaptured: 12, bindingStale: true }),
				stateWith({ available: false, disabledReason: null }),
				stateWith({ available: false, disabledReason: "no window found" }),
			];
			for (const state of cases) {
				const line = statusText(state) ?? "";
				// pi rewrites \r\n\t and collapses runs of spaces. The line
				// already contains none of those, so what was written is what
				// gets drawn — no surprise gap where a padding space was.
				assert.equal(piSanitize(line), line, `unstable line: ${JSON.stringify(line)}`);
				assert.doesNotMatch(line, /[\r\n\t]/);
				assert.doesNotMatch(line, / {2}/);
			}
		});
	});

	it("stays inside a narrow terminal once escape codes are discounted", () => {
		withColor({ NO_COLOR: "", FORCE_COLOR: "" }, () => {
			setPaint(true);
			try {
				const line = statusText(stateWith({ binding: BINDING, framesCaptured: 128 })) ?? "";
				assert.ok(stripEscapes(line).length <= 64, `too wide: ${stripEscapes(line)}`);
			} finally {
				setPaint(null);
			}
		});
	});

	it("lets pi's ctx.mode override the environment", () => {
		withColor({ NO_COLOR: "", FORCE_COLOR: "" }, () => {
			// FORCE_COLOR is unset and stdout is a pipe, so the environment
			// says no. `setPaint(true)` stands in for `ctx.mode === "tui"`.
			assert.equal(colorEnabled(), false);
			setPaint(true);
			try {
				assert.match(statusText(stateWith()) ?? "", ANY_ESC);
			} finally {
				setPaint(null);
			}
			assert.doesNotMatch(statusText(stateWith()) ?? "", ANY_ESC);
		});
	});
});

function stripEscapes(text: string): string {
	return text.replace(ALL_ESC, "");
}

/** pi-coding-agent's `sanitizeStatusText`, verbatim. */
function piSanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}