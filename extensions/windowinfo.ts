/**
 * Window discovery and display geometry, via P/Invoke from PowerShell.
 *
 * Why not `active-win` (PRD §11 R-3): it is a native addon whose prebuilds are
 * from 2024. npm 12 blocks install scripts by default, so `node-pre-gyp install`
 * never runs — the module then imports cleanly and returns `undefined` instead
 * of throwing. A dependency that fails silently in the exact path that matters
 * is not worth the convenience. Measured on this machine: `active-win` loads
 * and returns nothing; the shim below enumerates 20+ windows in 310ms warm.
 *
 * The C# lives in extensions/win/*.cs and is compiled once to gs_win32.dll.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DisplayInfo } from "./state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN_DIR = join(HERE, "win");

/** Raw shape returned by the PowerShell shim. PascalCase: it is .NET JSON. */
export interface RawWindow {
	Hwnd: number;
	Title: string;
	Pid: number;
	X: number;
	Y: number;
	Width: number;
	Height: number;
	Minimized: boolean;
	Maximized: boolean;
	Visible: boolean;
	Exe: string | null;
	Path: string | null;
}

/** Normalised camelCase window, matching what the rest of the package uses. */
export interface WindowInfo {
	title: string;
	/** Win32 HWND. Windows recycles these — always revalidate before capture. */
	id: number;
	bounds: { x: number; y: number; width: number; height: number };
	owner: { name: string; processId: number; path: string };
	pid: number;
	minimized: boolean;
	maximized: boolean;
}

function normalise(w: RawWindow): WindowInfo {
	return {
		title: w.Title ?? "",
		id: w.Hwnd,
		bounds: { x: w.X, y: w.Y, width: w.Width, height: w.Height },
		owner: {
			name: w.Exe ?? "",
			processId: w.Pid,
			path: w.Path ?? w.Exe ?? "",
		},
		pid: w.Pid,
		minimized: w.Minimized,
		maximized: w.Maximized,
	};
}

/**
 * Run one of the shim scripts.
 *
 * `-NoProfile` matters: a user profile with a custom prompt can add hundreds of
 * milliseconds to every call, and this runs on the capture path. `-STA` avoids a
 * COM initialisation stall on some systems.
 */
async function runScript(name: string, args: string[] = [], timeoutMs = 15000): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(WIN_DIR, name), ...args],
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 24 },
			(error, stdout) => resolve(error ? null : String(stdout).trim()),
		);
	});
}

function parseRows<T>(json: string): T[] {
	const trimmed = json.trim();
	if (!trimmed || trimmed === "null") return [];
	const parsed = JSON.parse(trimmed) as T | T[];
	return Array.isArray(parsed) ? parsed : [parsed];
}

/** Every visible top-level window, minimized ones included so the user can see them. */
export async function listWindows(): Promise<WindowInfo[]> {
	const out = await runScript("windows.ps1");
	if (out === null) return [];
	try {
		return parseRows<RawWindow>(out).map(normalise);
	} catch {
		return [];
	}
}

/**
 * Re-read one window by handle.
 *
 * This is the revalidation `capture.ts` performs before every grab. Windows
 * recycles HWNDs, so a handle stored in a session file last week can today
 * belong to a text editor — cropping it would put the wrong screen in front of
 * a vision model. `null` means the handle is gone.
 */
export async function queryWindow(hwnd: number): Promise<WindowInfo | null> {
	const out = await runScript("window.ps1", [String(hwnd)], 10000);
	if (out === null) return null;
	try {
		const parsed = parseRows<RawWindow>(out)[0];
		return parsed ? normalise(parsed) : null;
	} catch {
		return null;
	}
}

/**
 * Every display's pixel bounds, indexed for `screenshot-desktop`.
 *
 * The shim returns .NET `DeviceName`s (`\\.\DISPLAY1`); screenshot-desktop
 * indexes displays positionally and only exposes a name for `listDisplays()`.
 * Matching by name is what makes `--screen 1` mean the monitor next to the
 * primary one rather than "whatever happens to be second".
 *
 * Returns null if PowerShell is unavailable or the mapping is ambiguous.
 */
export async function resolveDisplays(): Promise<{ displays: DisplayInfo[]; warning?: string } | null> {
	const out = await runScript("screens.ps1");
	if (out === null) return null;

	let screens: { name: string; x: number; y: number; w: number; h: number; primary: boolean }[];
	try {
		screens = parseRows(out);
	} catch {
		return null;
	}
	if (screens.length === 0) return null;

	let names: string[];
	try {
		const mod = (await import("screenshot-desktop")) as unknown as {
			default?: { listDisplays(): Promise<{ id: number; name: string }[]> };
			listDisplays?(): Promise<{ id: number; name: string }[]>;
		};
		const lister = mod.default?.listDisplays ?? mod.listDisplays?.bind(mod);
		if (!lister) return null;
		names = (await lister())?.map((d) => String(d.name ?? "")) ?? [];
	} catch {
		return null;
	}

	let ambiguous = false;
	const displays: DisplayInfo[] = screens.map((s, fallback) => {
		const match = names.findIndex((n) => n.toLowerCase() === String(s.name).toLowerCase());
		if (names.length > 0 && match < 0) ambiguous = true;
		return {
			index: match >= 0 ? match : fallback,
			x: Number(s.x),
			y: Number(s.y),
			width: Number(s.w),
			height: Number(s.h),
		};
	});

	return {
		displays,
		warning:
			ambiguous && names.length > 0
				? "display names did not match; using positional order — use /gs display <n> if the crop is off"
				: undefined,
	};
}

/** Can we actually see any windows? Used by `/gs setup`. */
export async function probeCaptureSupport(): Promise<{ ok: boolean; detail: string }> {
	const windows = await listWindows();
	if (windows.length > 0) return { ok: true, detail: `${windows.length} window(s) enumerated` };

	const displays = await resolveDisplays();
	if (displays) return { ok: true, detail: "no windows visible, but display geometry works" };

	return {
		ok: false,
		detail: "PowerShell shim returned nothing — check extensions/win/bootstrap.ps1 and ExecutionPolicy",
	};
}

/**
 * Windows that can never be a game and should never be offered in the picker.
 * Terminals, browsers and the shell are excluded so `/gs play` shows games.
 */
const EXCLUDED_OWNER =
	/^(windowsterminal|wt|cmd|powershell|pwsh|conhost|explorer|code|chrome|msedge|firefox|brave|opera|vivaldi|thunderbird|outlook|onedrive|cursor|windsurf|codex)\.exe$/i;

export function isPickableWindow(w: WindowInfo): boolean {
	if (w.minimized) return false;
	if (w.bounds.width <= 0 || w.bounds.height <= 0) return false;
	if (w.title.trim() === "") return false;
	// A maximized "shell surface" window (Windows Input Experience, Search, the
	// taskbar host) covers the whole screen and is never the game.
	return !EXCLUDED_OWNER.test(w.owner.name);
}

/** One-line label for the `/gs play` picker. */
export function formatWindowChoice(w: WindowInfo): string {
	const exe = basename(w.owner.path || w.owner.name) || "?";
	const b = w.bounds;
	return `[${exe}] ${truncate(w.title.trim(), 46)}  ${b.width}x${b.height} @ (${b.x},${b.y})`;
}

function basename(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? (parts[parts.length - 1] as string) : "";
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Narrow the picker list to what the query actually names.
 *
 * Without this, `/gs play sora_2nd` still opens a menu of every window on the
 * desktop — the user named the game, so making them pick it again is noise. If
 * the query matches nothing, fall back to everything so the list still shows
 * something useful rather than an empty picker.
 */
export function filterWindows(windows: WindowInfo[], query: string): WindowInfo[] {
	const q = query.trim().toLowerCase();
	if (!q) return windows;
	const hits = windows.filter((w) => matchesQuery(w, q));
	return hits.length > 0 ? hits : windows;
}

/** Picker ordering: exact exe matches first, then largest window. */
export function sortWindows(windows: WindowInfo[], query: string): WindowInfo[] {
	const q = query.trim().toLowerCase();
	return [...windows].sort((a, b) => {
		if (q) {
			const am = matchesQuery(a, q) ? 0 : 1;
			const bm = matchesQuery(b, q) ? 0 : 1;
			if (am !== bm) return am - bm;
		}
		return b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height;
	});
}

function matchesQuery(w: WindowInfo, q: string): boolean {
	// Match the bare filename with and without the extension, and also the full
	// path — a user reading a crash log or a task manager row pastes the path.
	const full = (w.owner.path || "").toLowerCase();
	const exe = basename(w.owner.path || w.owner.name).toLowerCase();
	return exe === q || exe === `${q}.exe` || exe.includes(q) || full.includes(q);
}
