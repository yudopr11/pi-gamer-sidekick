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
 * A finished frame: JPEG bytes plus the numbers the rest of the pipeline needs.
 *
 * The shim does the scaling and the encoding, so nothing has to decode the
 * image again to find out how big it is or whether it is black.
 */
export interface Shot {
	/** Encoded JPEG. */
	jpeg: Buffer;
	width: number;
	height: number;
	/** Window or region size before the downscale. */
	sourceWidth: number;
	sourceHeight: number;
	/** Mean red channel, 0..255. A GDI grab under exclusive fullscreen is 0. */
	redMean: number;
}

interface RawShot {
	jpeg: string;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	redMean: number;
}

function parseShot(out: string | null): Shot | null {
	if (out === null || out === "null") return null;
	try {
		const raw = JSON.parse(out) as RawShot;
		if (typeof raw.jpeg !== "string" || raw.jpeg.length === 0) return null;
		return {
			jpeg: Buffer.from(raw.jpeg, "base64"),
			width: raw.width,
			height: raw.height,
			sourceWidth: raw.sourceWidth,
			sourceHeight: raw.sourceHeight,
			redMean: raw.redMean,
		};
	} catch {
		return null;
	}
}

/**
 * One finished frame of the bound window, ignoring what is on top of it.
 *
 * The alternative — grab the whole display and crop — cannot see past anything
 * covering the window, which for this package is always the terminal holding
 * the conversation. PrintWindow asks the window to draw itself instead.
 *
 * Returns null when the window declines to render (some D3D titles do), so
 * callers can fall back to the region grab rather than failing the turn.
 */
export async function captureWindowJpeg(hwnd: number, maxEdge: number, quality: number): Promise<Shot | null> {
	const out = await runScript("capture-jpeg.ps1", [String(hwnd), String(maxEdge), String(quality)], 20000);
	return parseShot(out);
}

/**
 * One finished frame of a display region, including anything covering it.
 *
 * The fallback for a window that will not draw itself. `rect` is
 * display-relative; the caller subtracts the display origin before calling.
 * The occluders are not detected here — that is a second process — so the
 * caller asks separately and has to say so in the caption.
 */
export async function grabRegion(
	displayIndex: number,
	rect: { left: number; top: number; width: number; height: number },
	maxEdge: number,
	quality: number,
): Promise<Shot | null> {
	const out = await runScript(
		"grab-region.ps1",
		[String(displayIndex), String(rect.left), String(rect.top), String(rect.width), String(rect.height), String(maxEdge), String(quality)],
		20000,
	);
	return parseShot(out);
}

/** Titles of windows covering `hwnd`, sampled on a 2x2 grid. Empty = clear. */
export async function probeOccluders(hwnd: number): Promise<string[]> {
	const out = await runScript("occluders.ps1", [String(hwnd)], 10000);
	if (out === null) return [];
	try {
		const parsed: unknown = JSON.parse(out);
		return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The display a window sits on, or null when its centre is off-screen.
 *
 * Positional: the region-grab path indexes displays, so a window spanning two
 * monitors must resolve to the one holding its centre or the crop is wrong.
 * Display geometry is resolved once at bind time and cached on the binding, so
 * this runs at bind time and again only if a window migrates at runtime.
 */
export function displayFor<T extends { index: number; x: number; y: number; width: number; height: number }>(
	displays: T[],
	bounds: { x: number; y: number; width: number; height: number },
): T | null {
	const cx = bounds.x + bounds.width / 2;
	const cy = bounds.y + bounds.height / 2;
	for (const d of displays) {
		if (cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) return d;
	}
	return null;
}

/**
 * Every display's pixel bounds, indexed for the region grab.
 *
 * The shim emits the index itself, because GrabRegion reads `Screen.AllScreens`
 * by the same ordinal. That is what makes display 1 mean the monitor next to
 * the primary one rather than "whatever the name matching guessed" — there is
 * no name matching, so there is nothing to be ambiguous about.
 *
 * Returns null if PowerShell is unavailable.
 */
export async function resolveDisplays(): Promise<{ displays: DisplayInfo[]; warning?: string } | null> {
	const out = await runScript("screens.ps1");
	if (out === null) return null;

	let screens: { i: number; x: number; y: number; w: number; h: number }[];
	try {
		screens = parseRows(out);
	} catch {
		return null;
	}
	if (screens.length === 0) return null;

	const displays: DisplayInfo[] = screens.map((s, fallback) => ({
		index: Number.isInteger(s.i) ? s.i : fallback,
		x: Number(s.x),
		y: Number(s.y),
		width: Number(s.w),
		height: Number(s.h),
	}));

	return { displays };
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
