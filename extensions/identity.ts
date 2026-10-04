/**
 * Game identity: turning an executable path into a stable per-game key.
 *
 * Pure functions, no I/O — fully unit tested (see test/identity.test.ts).
 *
 * Why a slug and not just the exe name: two installs of `eldenring.exe`
 * (Steam + pirated, or two library folders) are different games with different
 * builds. They must not share a conversation. §6.1.3 of the PRD.
 */

import { createHash } from "node:crypto";

/** A resolved game identity. The display key for status output. */
export interface GameIdentity {
	/** Lowercased executable basename, e.g. "eldenring.exe". The display key. */
	exe: string;
	/** `<sanitised-exe>-<8 hex chars>`. Unique per executable path. */
	slug: string;
	/** Full path to the executable, as reported by the window owner. */
	ownerPath: string;
}

/** Longest slug component before the hash suffix. */
const MAX_EXE_CHARS = 40;

/**
 * Derive the per-game identity from an executable path.
 *
 * Falls back to hashing the whole path when the basename is unusable
 * (empty, or nothing but separators) rather than throwing — a weird window
 * owner should degrade to an ugly slug, not break the picker.
 */
export function gameIdentity(ownerPath: string): GameIdentity {
	const normalized = ownerPath.trim();
	const base = basename(normalized);
	const exe = base.toLowerCase();
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);

	// Keep the extension readable (eldenring.exe, not eldenring-exe) but make
	// every other unsafe character inert for both filenames and ids.
	const sanitized = exe.replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	const head = (sanitized || "game").slice(0, MAX_EXE_CHARS);
	const slug = `${head}-${digest}`;

	return { exe: exe || "unknown", slug, ownerPath: normalized };
}

/** Last path segment, tolerating both Windows and POSIX separators. */
function basename(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? (parts[parts.length - 1] as string) : "";
}

/**
 * Does `query` look like it names this executable?
 *
 * Accepts `eldenring`, `eldenring.exe`, `ELDENRING.EXE`, and
 * `C:\Games\eldenring.exe`. Used by `/gs play <exe>` to skip the picker.
 */
export function matchesExe(identity: GameIdentity, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return false;
	if (q === identity.exe) return true;
	if (q === identity.exe.replace(/\.exe$/, "")) return true;
	return basename(q) === identity.exe;
}
