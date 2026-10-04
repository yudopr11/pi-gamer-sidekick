/**
 * Does `/gs` still dispatch after switch_session?
 *
 * Symptom: in a resumed conversation the status line counts frames correctly,
 * but `/gs frames` and `/gs status` come back with `disposition: undefined` and
 * go to the model as plain text instead of running.
 */

import { spawn } from "node:child_process";

const LAUNCHER = "C:/Users/yudop/.pi/agent/bin/pi-launcher.js";

interface Ev {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	method?: string;
	disposition?: string;
	command?: string;
	name?: string;
	commands?: { name: string; source?: string }[];
}

function run() {
	const child = spawn(process.execPath, [LAUNCHER, "--mode", "rpc", "--no-session"], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map<string, (e: Ev) => void>();
	let buffer = "";
	let nextId = 1;
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
			if (e.id && pending.has(e.id)) {
				pending.get(e.id)!(e);
				pending.delete(e.id);
			}
		}
	});
	const send = (payload: Record<string, unknown>): Promise<Ev> =>
		new Promise((resolve) => {
			const id = String(nextId++);
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
		});
	return { send, kill: () => child.kill() };
}

const { send, kill } = run();
await send({ type: "get_state" });
await new Promise((r) => setTimeout(r, 2500));

const cmds = (await send({ type: "get_commands" })) as Ev & { data: { commands?: Ev[] } };
const gs = cmds.data?.commands?.find((c) => c.name === "gs");
console.log(`gs registered        : ${gs ? `yes (source=${gs.source})` : "NO"}`);
console.log(`total commands       : ${cmds.data?.commands?.length}`);

const before = await send({ type: "prompt", message: "/gs status" });
console.log(`\nBEFORE switch_session`);
console.log(`  disposition        : ${before.disposition ?? "undefined — went to the model"}`);

await send({ type: "prompt", message: "/gs unbind" });
await new Promise((r) => setTimeout(r, 2000));

const after = await send({ type: "prompt", message: "/gs status" });
console.log(`\nAFTER  new_session (rebind path)`);
console.log(`  disposition        : ${after.disposition ?? "undefined — went to the model"}`);

kill();