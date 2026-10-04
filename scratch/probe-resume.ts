/**
 * Does /resume bring the frame back?
 *
 * Two separate questions, and they have different answers:
 *   1. does the model still see the image on a resumed turn?
 *   2. does the transcript still show it?
 *
 * Binds the game, asks a question so a frame lands, drops the process, resumes
 * the same session file, then asks something only the frame can answer.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gameIdentity } from "../extensions/identity.ts";

const LAUNCHER = "C:/Users/yudop/.pi/agent/bin/pi-launcher.js";
const GAME = process.env.GS_GAME ?? "sora_2nd";
const DIR = ".scratch/probe-resume";

const SESSION_DIR = join(DIR, "sessions");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(SESSION_DIR, { recursive: true });

interface Ev {
	type: string;
	id?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	method?: string;
	statusText?: string;
	message?: { role?: string; content?: unknown } & Record<string, unknown>;
	text?: string;
}

interface Run {
	send(payload: Record<string, unknown>): Promise<Ev>;
	settle(): Promise<void>;
	kill(): void;
	events: Ev[];
	statuses: string[];
	notices: string[];
	assistants: string[];
}

function run(): Run {
	const child = spawn(process.execPath, [LAUNCHER, "--mode", "rpc", "--session-dir", SESSION_DIR], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map<string, (e: Ev) => void>();
	const events: Ev[] = [];
	const assistants: string[] = [];
	const statuses: string[] = [];
	const notices: string[] = [];
	let buffer = "";
	let nextId = 1;
	let settled: Promise<void> = Promise.resolve();

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: Ev;
			try {
				e = JSON.parse(line) as Ev;
			} catch {
				continue;
			}
			events.push(e);
			if (e.type === "message_end" && e.message?.role === "assistant") {
				const content = e.message.content as { type: string; text?: string }[] | undefined;
				assistants.push((content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""));
			}
			if (e.type === "agent_settled") settled = Promise.resolve();
			if (e.type === "extension_ui_request" && e.id && e.method === "select") {
				const opt = (e.data as { options?: { label?: string }[] } | undefined)?.options?.find((o) => (o.label ?? "").includes(GAME));
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: e.id, value: opt?.label })}\n`);
			}
			if (e.type === "extension_ui_request" && e.method === "setStatus") statuses.push(String(e.statusText ?? ""));
			if (e.type === "extension_ui_request" && e.method === "notify") notices.push(String((e as unknown as { message?: string }).message ?? ""));
			if (e.id && pending.has(e.id)) {
				pending.get(e.id)!(e);
				pending.delete(e.id);
			}
		}
	});

	return {
		send: (payload) =>
			new Promise((resolve) => {
				const id = String(nextId++);
				pending.set(id, resolve);
				child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
			}),
		settle: async () => {
			for (let i = 0; i < 90; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				if (events.some((e) => e.type === "agent_settled")) return;
			}
		},
		kill: () => child.kill(),
		events,
		statuses,
		notices,
		assistants,
	};
}

/** How many image blocks are in the messages pi is holding right now? */
function imageCount(messages: unknown): number {
	let n = 0;
	for (const m of (messages as { content?: unknown }[]) ?? []) {
		const content = m?.content;
		if (Array.isArray(content)) for (const c of content) if ((c as { type?: string })?.type === "image") n++;
	}
	return n;
}

const first = run();
await first.send({ type: "get_state" });
await new Promise((r) => setTimeout(r, 1200));
await first.send({ type: "prompt", message: `/gs play ${GAME}` });
await new Promise((r) => setTimeout(r, 3000));
await first.send({ type: "prompt", message: "describe exactly what is on my screen, and name the game." });
await first.settle();

const beforeAsk = (await first.send({ type: "get_messages" })) as Ev & { data: { messages?: unknown[] } };
const path = beforeAsk.data?.sessionFile as string | undefined;
const id = beforeAsk.data?.sessionId as string | undefined;
const answer1 = (first.events.filter((e) => e.type === "message_end") as (Ev & { message: { content: { type: string; text?: string }[] } })[])
	.flatMap((e) => e.message.content)
	.filter((c) => c.type === "text")
	.map((c) => c.text)
	.join(" ");
first.kill();
await new Promise((r) => setTimeout(r, 800));

const dir = SESSION_DIR;
const { readdirSync, statSync } = await import("node:fs");
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const sessionFile = files[0] ?? "";
const raw = readFileSync(sessionFile, "utf8");
const imageLines = raw.split("\n").filter((l) => l.includes('"type":"image"'));
const customLines = raw.split("\n").filter((l) => l.includes("custom_message") && l.includes("gamer_sidekick_frame"));

console.log(`\nsession file        : ${sessionFile.split("\\").pop()}  (${(raw.length / 1024).toFixed(0)} KB)`);
console.log(`frames on disk      : ${customLines.length} custom_message entries, ${imageLines.length} image blocks`);
console.log(`answers the name?   : ${/trails|sky|sora/i.test(answer1) ? "yes — saw the frame" : "NO"}`);

console.log(`\n--- restarting pi on that exact file (this is /resume) ---`);

// Ask a question only answerable by looking at the frame again.
writeFileSync(join(DIR, "resume-prompt.txt"), "");
const second = run();
await second.send({ type: "get_state" });
await new Promise((r) => setTimeout(r, 1500));

const resumed = (await second.send({ type: "switch_session", sessionPath: sessionFile })) as Ev;
await new Promise((r) => setTimeout(r, 2500));
const state = (await second.send({ type: "get_messages" })) as Ev & { data: { messages?: unknown[] } };
const afterResume = imageCount(state.data?.messages);

// Ask the two commands that report on frames, without sending a message.
const d1 = await second.send({ type: "prompt", message: "/gs frames" });
console.log("disposition /gs frames :", d1.data?.disposition);
await new Promise((r) => setTimeout(r, 2500));
const d2 = await second.send({ type: "prompt", message: "/gs status" });
console.log("disposition /gs status :", d2.data?.disposition);
await new Promise((r) => setTimeout(r, 2500));

await second.send({ type: "prompt", message: "still the same scene? name the game and what the party is doing." });
await second.settle();
const answer2 = (second.events.filter((e) => e.type === "message_end") as (Ev & { message: { content: { type: string; text?: string }[] } })[])
	.flatMap((e) => e.message.content)
	.filter((c) => c.type === "text")
	.map((c) => c.text)
	.join(" ");
second.kill();

console.log(`switch_session      : ${resumed.success ? "ok" : resumed.success === false ? "refused" : "?"}`);
console.log(`images in memory    : ${afterResume}`);
console.log(`model still sees it : ${/trails|sky|sora/i.test(answer2) ? "yes" : "NO"}`);
console.log(`\nstatus line after resume :`);
for (const s of [...new Set(second.statuses)]) console.log(`  ${s}`);
console.log(`/gs frames said          :`);
for (const n of second.notices) console.log(`  ${n.replace(/\n/g, "\n  ")}`);
console.log(`/gs status said          :`);
for (const n of second.notices.filter((x) => /frames\s+\d/.test(x))) console.log(`  ${n.replace(/\n/g, "\n  ")}`);
console.log(`\nanswer after resume :\n${answer2.slice(0, 500)}`);