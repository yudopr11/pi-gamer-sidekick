/**
 * Live probe: does a binding survive the session switch that `/gs play` causes?
 *
 * The bug this was written for: `/gs play` reported success and then the status
 * line went back to "no game bound", because the binding entry had been written
 * to the session that was being *left*. Nothing errored — the write simply went
 * somewhere unreachable.
 *
 * So this drives a real pi over RPC, answers the dialogs a headless driver would
 * otherwise hang on, and asks three separate questions:
 *
 *   1. is the binding entry in the session that is current *after* the switch?
 *   2. does the next turn pick that binding up (session gets named)?
 *   3. does that turn actually capture a frame?
 *
 * Usage: node --experimental-strip-types scratch/probe-bind.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PI = "C:/Users/yudop/.pi/agent/bin/pi-launcher.js";
const GAME = process.env.GS_GAME ?? "sora_2nd";

type Entry = { type: string; customType?: string; data?: unknown };

const child = spawn(process.execPath, [PI, "--mode", "rpc"], {
	cwd: "C:/Users/yudop/Projects/sidekick",
	stdio: ["pipe", "pipe", "inherit"],
});

const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);

const result = {
	binding: undefined as Entry | undefined,
	frame: undefined as Entry | undefined,
	sessionName: "(unnamed)",
	statuses: [] as string[],
	statusAfterBind: "(none)",
	notices: [] as string[],
	sawAsk: false,
};

/** Ask for the session state + entries under one id and fold them in. */
function inspect(id: string): void {
	send({ id: `${id}-state`, type: "get_state" });
	send({ id: `${id}-entries`, type: "get_entries" });
}

function entriesOf(data: Record<string, unknown> | undefined): Entry[] {
	return (data?.entries as Entry[]) ?? [];
}

function afterBind(): void {
	result.sawAsk = true;
	console.log("  asking one question so the turn hooks run...");
	send({ id: "ask", type: "prompt", message: "Reply with exactly: OK" });
}

/** The turn finished: give the async extension work a beat, then re-inspect. */
function afterTurn(): void {
	setTimeout(() => inspect("post"), 1500);
}

createInterface({ input: child.stdout }).on("line", (line) => {
	let msg: Record<string, unknown>;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (msg.type === "extension_ui_request") {
		const method = msg.method as string;
		if (method === "setStatus") result.statuses.push(String(msg.statusText));
		if (method === "notify") result.notices.push(String(msg.message));
		// A headless driver must answer dialogs or it waits out the 180s timeout.
		if (method === "confirm") {
			send({ type: "extension_ui_response", id: msg.id, confirmed: true });
		} else if (method === "select") {
			const options = msg.options as string[];
			const pick = options.find((o) => o.includes(GAME)) ?? options[0];
			send({ type: "extension_ui_response", id: msg.id, value: pick });
		}
		return;
	}

	if (msg.type === "agent_settled") {
		if (result.sawAsk) afterTurn();
		return;
	}

	if (msg.type !== "response") return;

	const id = msg.id as string;
	const data = msg.data as Record<string, unknown> | undefined;

	if (id === "play") {
		console.log(`  /gs play ${GAME}  ->  success=${msg.success}`);
		inspect("post-bind");
	} else if (id === "cold") {
		console.log("  started a fresh session (cold path)");
		send({ id: "play", type: "prompt", message: `/gs play ${GAME}` });
	} else if (id === "post-bind-state") {
		result.sessionName = (data?.sessionName as string) ?? "(unnamed)";
		// The regression this was rewritten for: a bind that succeeds while the
		// status line keeps saying "no game bound".
		result.statusAfterBind = result.statuses.at(-1) ?? "(none)";
	} else if (id === "post-bind-entries") {
		result.binding = entriesOf(data).find((e) => e.customType === "gamer_sidekick_binding");
		afterBind();
	} else if (id === "post-state") {
		result.sessionName = (data?.sessionName as string) ?? "(unnamed)";
	} else if (id === "post-entries") {
		result.frame = entriesOf(data).find((e) => e.customType === "gamer_sidekick_frame");
		report();
	}
});

function report(): void {
	const bound = Boolean(result.binding);
	const shot = Boolean(result.frame);
	const toldTruth = !/no game bound/.test(result.statusAfterBind);
	// A1: the package does not own conversation titles. Anything starting with
	// "gamer-sidekick/" means we renamed the player's conversation.
	const namedByUs = /^gamer-sidekick\//.test(result.sessionName);
	const ok = bound && shot && toldTruth && !namedByUs;

	console.log("");
	console.log(`  binding entry  : ${bound ? "present in the current session" : "MISSING"}`);
	console.log(`  session name   : ${result.sessionName}`);
	console.log(`  status after /gs play : ${result.statusAfterBind}${toldTruth ? "" : "   <-- STALE"}`);
	console.log(`  frame captured : ${shot ? "yes — the next turn used the binding" : "NO — nothing was captured"}`);
	console.log(`  renamed your conversation? ${namedByUs ? "YES — that is a bug (A1)" : "no"}`);
	console.log(`  last status    : ${result.statuses.at(-1) ?? "(none)"}`);
	console.log(`  notices        : ${JSON.stringify(result.notices.slice(0, 3))}`);
	if (result.frame) console.log(`  frame record   : ${JSON.stringify(result.frame.data)}`);
	console.log("");
	console.log(ok ? "PASS — bound in place, conversation untouched, captured on the next turn." : "FAIL");
	child.kill();
	process.exit(ok ? 0 : 1);
}

setTimeout(() => {
	console.log("FAIL — timed out after 150s waiting for pi to answer.");
	child.kill();
	process.exit(1);
}, 150_000);

setTimeout(() => {
	console.log(`  /gs play ${GAME}`);
	send({ id: "play", type: "prompt", message: `/gs play ${GAME}` });
}, 2500);