/**
 * Per-game sessions. PRD §6.5.
 *
 * Each bound game gets a pi session named `gamer-sidekick/<slug>`. Asking about
 * Elden Ring on Tuesday and Baldur's Gate on Wednesday should not produce a
 * model that thinks you are still in Leyndell, and it should not cost you the
 * Elden Ring thread.
 *
 * Switching is explicit (`/gs play`, `--gs-switch`) rather than automatic. A
 * package that silently swaps the session out from under you mid-conversation
 * loses your place, and a vision context is expensive to rebuild.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GameIdentity } from "./identity.ts";

/** Prefix for every session this package owns. */
export const SESSION_PREFIX = "gamer-sidekick/";

/** Root of a session file's basename, which is its UUID. */
function sessionIdFromFile(file: string): string | null {
	const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
	return m?.[1] ?? null;
}

export interface GameSessionSummary {
	sessionId: string;
	path: string;
	slug: string;
	exe: string;
	modified: Date;
	messageCount: number;
	/** The slug, or "unnamed", if no session_info entry was found. */
	name: string | null;
	active: boolean;
}

/**
 * List this package's sessions, newest first.
 *
 * Reads only the head of each file: enough to find the name and count messages,
 * without loading a 40 MB Elden Ring thread into memory to render a list.
 */
export async function listGameSessions(sessionDir: string, activeSessionId?: string): Promise<GameSessionSummary[]> {
	let files: string[];
	try {
		files = await readdir(sessionDir);
	} catch {
		return [];
	}

	const candidates = files.filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, id: sessionIdFromFile(f) }));
	const out: GameSessionSummary[] = [];

	for (const { f, id } of candidates) {
		if (!id) continue;
		const path = join(sessionDir, f);
		const head = await readHead(path);
		if (head === null) continue;

		const name = head.name;
		if (!name?.startsWith(SESSION_PREFIX)) continue;

		const slug = name.slice(SESSION_PREFIX.length);
		out.push({
			sessionId: id,
			path,
			slug,
			exe: slug.replace(/-[0-9a-f]{8}$/, ""),
			modified: head.modified,
			messageCount: head.messageCount,
			name,
			active: id === activeSessionId,
		});
	}

	out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return out;
}

async function readHead(
	path: string,
): Promise<{ name: string | null; modified: Date; messageCount: number } | null> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return null;
	}

	let name: string | null = null;
	let messageCount = 0;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string };
			if (entry.type === "message" || entry.type === "custom_message") messageCount++;
			if (entry.type === "session_info" && name === null) {
				const n = (entry as { name?: unknown }).name;
				name = typeof n === "string" ? n : null;
			}
		} catch {
			// A partially-written trailing line is normal while pi is running.
		}
	}

	let modified: Date;
	try {
		modified = new Date((await stat(path)).mtimeMs);
	} catch {
		modified = new Date();
	}

	return { name, modified, messageCount };
}

/** Find the stored session for a game identity, if any. */
export async function findSessionFor(sessionDir: string, identity: GameIdentity): Promise<GameSessionSummary | undefined> {
	const all = await listGameSessions(sessionDir);
	return all.find((s) => s.slug === identity.slug);
}

/** Does this session name belong to this package? */
export function isGameSession(name: string | null | undefined): boolean {
	return typeof name === "string" && name.startsWith(SESSION_PREFIX);
}

/** Default session name for a newly bound game. */
export function sessionNameFor(identity: GameIdentity): string {
	return `${SESSION_PREFIX}${identity.slug}`;
}
