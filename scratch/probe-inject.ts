/**
 * End-to-end integration probe: real Windows capture → real context handler.
 *
 * The unit tests inject a fake capture function, so they prove the injection
 * logic but not the capture. This probe closes that gap: it binds the live
 * game window, lets the production capture path run, then drives the real
 * `before_agent_start` and `context` handlers and inspects what a provider
 * would actually receive.
 *
 * Usage:  node --experimental-strip-types scratch/probe-inject.ts [exeFilter]
 *
 * Writes nothing to disk inside the package — the JPEG is kept in memory, which
 * is the same guarantee the design claims.
 */

import { registerAttachment } from "../extensions/attach.ts";
import { gameIdentity } from "../extensions/identity.ts";
import { createState, type SidekickState } from "../extensions/state.ts";
import { listWindows, queryWindow, resolveDisplays, isPickableWindow } from "../extensions/windowinfo.ts";

const filter = process.argv[2]?.toLowerCase() ?? "";

// --- pick a target -----------------------------------------------------------

const windows = (await listWindows()).filter(isPickableWindow);
console.log("pickable windows:");
for (const w of windows) {
	console.log(`  ${String(w.id).padStart(10)}  ${w.owner.name}  ${w.bounds.width}x${w.bounds.height}  ${w.title.slice(0, 50)}`);
}

const target = windows.find((w) => w.owner.name.toLowerCase().includes(filter));
if (!target) {
	console.error(`\nno pickable window matching "${filter || "(any)"}" — is the game running?`);
	process.exit(1);
}
const live = await queryWindow(target.id);
if (!live) {
	console.error(`window ${target.id} vanished between enumerate and query`);
	process.exit(1);
}
const { displays } = await resolveDisplays();

// --- bind --------------------------------------------------------------------

const state: SidekickState = createState();
state.available = true;
state.binding = {
	hwnd: live.id,
	identity: gameIdentity(live.owner.path),
	title: live.title,
	bounds: live.bounds,
	display: displays[0] ?? null,
	boundAt: new Date().toISOString(),
	follow: false,
	displayOverride: null,
};
console.log(`\nbound: ${live.owner.name} hwnd=${live.id} session=${state.binding.identity.sessionName}`);

// --- drive the real handlers -------------------------------------------------

type Handler = (e: never, c: never) => unknown;
const handlers = new Map<string, Handler[]>();
const appended: unknown[] = [];

const pi = {
	on(event: string, h: Handler) {
		const list = handlers.get(event) ?? [];
		list.push(h);
		handlers.set(event, list);
	},
	appendEntry(_type: string, data: unknown) {
		appended.push(data);
	},
	ui: { notify: (m: string) => console.log(`  notify: ${m}`) },
} as unknown as Parameters<typeof registerAttachment>[0];

registerAttachment(pi as Parameters<typeof registerAttachment>[0], state);

const fire = async (event: string, payload: unknown) => {
	const out: unknown[] = [];
	for (const h of handlers.get(event) ?? []) out.push(await (h as (e: unknown, c: unknown) => unknown)(payload, pi));
	return out[0];
};

const question = "What should I do next in this scene?";
await fire("before_agent_start", { type: "before_agent_start", prompt: question });

if (!state.pendingFrame) {
	console.error(`\ncapture failed: ${state.lastError}`);
	process.exit(1);
}
const r = state.pendingFrame.record;
console.log(
	`\ncaptured #${String(r.id).padStart(3, "0")}  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(0)} KB  ~${r.imageTokens} image tokens`,
);

// --- what the provider would receive -----------------------------------------

const result = (await fire("context", {
	type: "context",
	messages: [{ role: "user", content: question, timestamp: Date.now() }],
})) as { messages?: { role: string; content: unknown }[] } | undefined;

const messages = result?.messages ?? [];
console.log(`\nprovider request: ${messages.length} message(s)`);
for (const m of messages) {
	const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Record<string, string>[]);
	for (const b of blocks) {
		if (b.type === "text") console.log(`  [text ] ${b.text}`);
		else console.log(`  [image] ${b.mimeType}  data=${(b.data?.length ?? 0)} b64 chars  (hash ${r.hash})`);
	}
}

// --- the two invariants ------------------------------------------------------

const serialized = JSON.stringify(appended);
const b64 = state.pendingFrame.data;
let ok = true;

console.log("\nchecks:");
const check = (label: string, pass: boolean) => {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
	if (!pass) ok = false;
};
check(`appendEntry payload carries no image data (${serialized.length} bytes)`, !serialized.includes(b64));
check("appended record is metadata only", typeof (appended[0] as Record<string, unknown>)?.data === "undefined");
check("exactly one image block in the request", messages.filter((m) => JSON.stringify(m.content).includes(b64)).length === 1);

console.log(`\n${ok ? "OK" : "PROBLEMS FOUND"}`);
process.exit(ok ? 0 : 1);