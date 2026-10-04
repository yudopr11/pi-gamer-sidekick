/**
 * Live probe for amendment A2: the frame is part of the normal conversation.
 *
 * Binds the running game, asks a question, then reads the session file back to
 * check what actually landed in the transcript. Not part of the package.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildFrameMessage } from "../extensions/attach.ts";

const LAUNCHER = join(homedir(), ".pi/agent/bin/pi-launcher.js");
const GAME = process.env.GS_GAME ?? "sora_2nd";

interface RpcEvent {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	method?: string;
	statusText?: string;
	message?: string;
	text?: string;
	disposition?: string;
}

function rpc() {
	const child = spawn(process.execPath, [LAUNCHER, "--mode", "rpc", "--session-dir", SESSIONS], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map<string, (e: RpcEvent) => void>();
	const notices: string[] = [];
	const events: RpcEvent[] = [];
	let buffer = "";
	let nextId = 1;

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let event: RpcEvent;
			try {
				event = JSON.parse(line) as RpcEvent;
			} catch {
				continue;
			}
			events.push(event);
			if (event.type === "extension_ui_request") {
				const { id } = event as { id?: string };
				// Auto-answer so the probe never blocks on a picker.
				if (id && event.method === "confirm") child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, confirmed: true })}\n`);
				if (id && event.method === "select") {
					const option = (event.data as { options?: { label?: string }[] } | undefined)?.options?.find((o) =>
						(o.label ?? "").includes(GAME),
					);
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, value: option?.label })}\n`);
				}
				if (event.method === "setStatus") notices.push(String(event.statusText ?? ""));
				continue;
			}
			if (event.id && pending.has(event.id)) {
				pending.get(event.id)!(event);
				pending.delete(event.id);
			}
		}
	});

	const send = (payload: Record<string, unknown>): Promise<RpcEvent> =>
		new Promise((resolve) => {
			const id = String(nextId++);
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
		});

	return { child, send, events, notices };
}

const SESSIONS = join(process.cwd(), ".scratch/probe-session");
rmSync(SESSIONS, { recursive: true, force: true });
mkdirSync(SESSIONS, { recursive: true });

/** Every .jsonl currently on disk, as absolute paths. */
function existingFiles(): Set<string> {
	const out = new Set<string>();
	for (const group of readdirSync(SESSIONS, { withFileTypes: true })) {
		const dir = group.isDirectory() ? join(SESSIONS, group.name) : SESSIONS;
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".jsonl")) out.add(join(dir, f));
		}
	}
	return out;
}

/** The conversation this run just wrote. */
function newestFile(before: Set<string>): string | null {
	const fresh = [...existingFiles()].filter((f) => !before.has(f));
	fresh.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return fresh[0] ?? null;
}

const before = existingFiles();

const { child, send, events, notices } = rpc();

await send({ type: "get_state" });
await new Promise((r) => setTimeout(r, 1200));

const play = await send({ type: "prompt", message: `/gs play ${GAME}` });
console.log(`/gs play -> ${play.disposition ?? play.success}`);

await send({ type: "prompt", message: "what is on my screen right now?" });
// Let the turn stream to completion.
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	if (events.some((e) => e.type === "agent_settled")) break;
}

const answered = events.some((e) => e.type === "message_end");
const file = newestFile(before);
child.kill();

console.log(`\nturn answered : ${answered ? "yes" : "NO"}`);
console.log(`status seen   : ${[...new Set(notices)].slice(-2).join("  |  ")}`);

if (!file) {
	console.log("no new session file — cannot verify what was persisted");
	process.exit(1);
}

const raw = readFileSync(file, "utf8");
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const b64Matches = raw.match(/"data":"[A-Za-z0-9+/=]{2000,}"/g) ?? [];
let frameBytes = 0;
let frameMsgs = 0;
for (const line of raw.split("\n")) {
	if (!line.trim()) continue;
	const entry = JSON.parse(line) as { type: string; customType?: string; content?: { type: string; text?: string; data?: string }[]; display?: boolean };
	// pi stores the frame as a top-level custom_message entry.
	if (entry.type !== "custom_message") continue;
	frameBytes += Buffer.byteLength(line);
	frameMsgs++;
	console.log(`\nconversation entry  role=custom_message display=${entry.display}`);
	console.log(`  customType : ${entry.customType}`);
	for (const block of entry.content ?? []) {
		console.log(`  ${block.type.padEnd(6)} : ${block.type === "text" ? `${String(block.text).slice(0, 76)}…` : `${kb(block.data?.length ?? 0)} base64`}`);
	}
}

console.log(`\nsession file  : ${kb(statSync(file).size)} total`);
console.log(`frame messages: ${frameMsgs} (${kb(frameBytes)} of the file)`);
const ok = answered && frameMsgs >= 1 && frameBytes > 0;
console.log(`\n${ok ? "PASS" : "FAIL"} — the frame is in the conversation, not just in the request.`);

// The pure half of the assertion: the builder hands pi something it can store.
const probe = buildFrameMessage({
	record: {
		id: 1,
		exe: "x.exe",
		width: 1,
		height: 1,
		bytes: 1,
		hash: "0",
		timestamp: Date.now(),
		imageTokens: 0,
	},
	data: "AAAA",
	mimeType: "image/jpeg",
});
console.log(`buildFrameMessage -> ${JSON.stringify({ customType: probe.customType, blocks: probe.content.map((c) => c.type), display: probe.display })}`);