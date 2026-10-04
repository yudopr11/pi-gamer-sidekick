/**
 * Live loop probe: run a real pi session against the real game window.
 *
 * Phase 1 asks pi to run `/gs play <exe>`, which binds the window and appends
 * the binding to the session file.
 * Phase 2 continues that session and asks a real question, so the extension
 * restores the binding from the session, captures a frame, injects it at the
 * `context` event, and a vision model actually answers.
 *
 * Phase 2 is the whole product in one command.
 *
 * Usage:  node --experimental-strip-types scratch/probe-live.ts [exeFilter]
 *
 * Spawning through node (rather than the shell) is deliberate: under Git Bash,
 * MSYS path conversion rewrites any argument starting with `/` — including
 * `/gs play` — into `C:/Program Files/Git/gs`. A real user in a terminal will
 * not hit this, but a shell-driven harness will.
 */

import { spawn } from "node:child_process";

const LAUNCHER = "C:/Users/yudop/.pi/agent/bin/pi-launcher.js";
const filter = process.argv[2] ?? "sora_2nd";

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [LAUNCHER, ...args], {
			cwd: process.cwd(),
			env: { ...process.env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}\n${err}\n${out}`))));
	});
}

const BASE = ["-e", "./extensions/index.ts", "--no-extensions", "--no-tools", "--no-context-files"];
const SESSION_ID = `gs-probe-${Date.now().toString(36)}`;

console.log("=== phase 1: bind the game window ===");
const bind = await run([...BASE, "--session-id", SESSION_ID, "-p", `/gs play ${filter}`]);
console.log(bind.trim() || "(no output)");

console.log("\n=== phase 2: ask a real question with the frame attached ===");
const ask = await run([
	...BASE,
	"--session-id",
	SESSION_ID,
	"-p",
	"Look at the attached game frame. In one short paragraph: what is happening on screen, and what should the player do next?",
]);
console.log(ask.trim());

console.log("\n=== session file: metadata only, no image bytes ===");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const home = process.env.USERPROFILE ?? "";
const dir = join(home, ".pi", "agent", "sessions");
const { readdirSync, statSync } = await import("node:fs");
const files = readdirSync(dir, { recursive: true, encoding: "utf8" }) as unknown as string[];
const hit = files
	.filter((f) => f.endsWith(".jsonl") && f.includes(SESSION_ID))
	.map((f) => join(dir, f))
	.filter((f) => statSync(f).size > 0);
for (const f of hit) {
	const text = readFileSync(f, "utf8");
	const hasDataUrl = text.includes("data:image") || text.includes("base64,");
	console.log(`${f}  ${(text.length / 1024).toFixed(1)} KB`);
	console.log(`  frame entries: ${(text.match(/gamer_sidekick_frame/g) ?? []).length}`);
	console.log(`  binding entries: ${(text.match(/gamer_sidekick_binding/g) ?? []).length}`);
	console.log(`  contains base64 image data: ${hasDataUrl ? "YES — INV-2 VIOLATED" : "no"}`);
}