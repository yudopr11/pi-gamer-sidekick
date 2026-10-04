/**
 * Live probe for amendment A3: capture happens when the model asks, not on
 * every message.
 *
 * Binds the running game, asks three questions — two about the game, one about
 * the screen — and reads the session file back to see what was actually
 * captured. Not part of the package.
 *
 * The deterministic assertion is that the *automatic* path never fires: no
 * conversation message carrying a frame, and no ledger entry with
 * `reason: "prompt"`. How many times the model reaches for `game_frame` is
 * model behaviour, not a package invariant, so that part is reported rather
 * than asserted.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCHER = process.env.PI_LAUNCHER ?? join(homedir(), ".pi/agent/bin/pi-launcher.js");
const GAME = process.env.GS_GAME ?? "sora_2nd";

/**
 * pi loads whichever copy is *installed* (`~/.pi/agent/git/...`), not this
 * checkout, so a probe would otherwise measure the last pushed commit and
 * quietly report the old behaviour as passing. Point it at the working tree.
 */
const ROOT = process.cwd();
const SESSIONS = join(ROOT, ".scratch/probe-ondemand");
const ARGS = [
	"--mode", "rpc",
	"--session-dir", SESSIONS,
	"--no-extensions",
	"-e", join(ROOT, "extensions/index.ts"),
	"--prompt-template", join(ROOT, "prompts"),
	"--skill", join(ROOT, "skills/gaming-companion"),
];

const QUESTIONS = [
	{ q: "In this game, what are the three basic arts and what is each one for?", needs: "game knowledge" },
	{ q: "How do I beat the second boss?", needs: "strategy" },
	{ q: "What just happened on my screen?", needs: "the screen" },
];

interface RpcEvent {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	method?: string;
	statusText?: string;
}

rmSync(SESSIONS, { recursive: true, force: true });
mkdirSync(SESSIONS, { recursive: true });

function rpc() {
	const child = spawn(process.execPath, [LAUNCHER, ...ARGS], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map<string, (e: RpcEvent) => void>();
	const notices: string[] = [];
	// pi streams newline-delimited JSON. One reader, one parse, two consumers:
	// RPC replies by id, and turn lifecycle for the settle marker.
	let buffer = "";
	let nextId = 1;
	let settled = false;

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
			if (event.type === "agent_settled") settled = true;
			if (event.type === "extension_ui_request") {
				const { id } = event as { id?: string };
				if (id && event.method === "confirm") {
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, confirmed: true })}\n`);
				}
				if (id && event.method === "select") {
					const option = (event.data as { options?: { label?: string }[] } | undefined)?.options?.find(
						(o) => (o.label ?? "").includes(GAME),
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

	/** Fire a prompt and wait for the agent to go idle again. */
	const ask = async (message: string, seconds = 120): Promise<boolean> => {
		settled = false;
		await send({ type: "prompt", message });
		for (let i = 0; i < seconds; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			if (settled) return true;
		}
		return false;
	};

	return { child, send, ask, notices };
}

function existingFiles(): Set<string> {
	const out = new Set<string>();
	for (const group of readdirSync(SESSIONS, { withFileTypes: true })) {
		const dir = group.isDirectory() ? join(SESSIONS, group.name) : SESSIONS;
		for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) out.add(join(dir, f));
	}
	return out;
}

const before = existingFiles();
const { child, send, ask, notices } = rpc();

await send({ type: "get_state" });
await new Promise((r) => setTimeout(r, 1200));

const play = await send({ type: "prompt", message: `/gs play ${GAME}` });
// The disposition is nested under `data` on a prompt reply, not top level.
console.log(`/gs play ${GAME} -> ${(play.data as { disposition?: string } | undefined)?.disposition ?? String(play.success)}\n`);

for (const [i, { q, needs }] of QUESTIONS.entries()) {
	console.log(`[${i + 1}] ${needs.padEnd(14)} ${q}`);
	const answered = await ask(q);
	if (!answered) console.log("    (timed out waiting for the turn to finish)");
}

const file = [...existingFiles()]
	.filter((f) => !before.has(f))
	.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
child.kill();

if (!file) {
	console.log("\nno new session file — cannot verify what was persisted");
	process.exit(1);
}

let autoCaptures = 0;
let toolCaptures = 0;
let autoMessages = 0;
let toolResults = 0;

for (const line of readFileSync(file, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const entry = JSON.parse(line) as {
		type: string;
		customType?: string;
		data?: { reason?: string };
		message?: { role?: string };
	};
	if (entry.customType === "gamer_sidekick_frame") {
		if (entry.data?.reason === "prompt") autoCaptures++;
		else toolCaptures++;
	}
	// The always-on path attaches a conversation message; it must never fire now.
	if (entry.type === "custom_message" && entry.customType === "gamer_sidekick_frame") autoMessages++;
	// pi records a tool return as a `toolResult` message, not a `tool_call`.
	if (entry.type === "message" && entry.message?.role === "toolResult") toolResults++;
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(`\nsession file        : ${kb(statSync(file).size)}`);
console.log(`questions asked     : ${QUESTIONS.length}`);
console.log(`tool results        : ${toolResults}`);
console.log(`frames via the tool : ${toolCaptures}   (reason: "tool")`);
console.log(`frames automatically: ${autoCaptures}   (reason: "prompt")`);
console.log(`auto frame messages : ${autoMessages}   (the /gs auto on path — must be 0)`);
console.log(`status              : ${[...new Set(notices)].slice(-1)[0] ?? "(none)"}`);

const ok = autoCaptures === 0 && autoMessages === 0;
console.log(
	`\n${ok ? "PASS" : "FAIL"} — no message captured a frame on its own; every frame came from the model asking.`,
);
if (toolCaptures === 0) {
	console.log("NOTE the model never called game_frame. That is the known cost of A3 — /gs auto on is the fallback.");
}
process.exit(ok ? 0 : 1);