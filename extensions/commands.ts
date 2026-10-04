/**
 * The `/gs` command surface. PRD §6.6.1.
 *
 * One command with subcommands, not twelve commands. Slash commands are cheap
 * in pi but each one costs the user a name to remember; `/gs play` and
 * `/gs play` are the same muscle memory.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { describeFailure } from "./attach.ts";
import { pinFrame, unpinFrame } from "./frames.ts";
import { gameIdentity } from "./identity.ts";
import { findSessionFor, isGameSession, listGameSessions, SESSION_PREFIX } from "./sessions.ts";
import { formatSize, type Binding, type SidekickState } from "./state.ts";
import {
	filterWindows,
	formatWindowChoice,
	isPickableWindow,
	listWindows,
	probeCaptureSupport,
	resolveDisplays,
	sortWindows,
	type WindowInfo,
} from "./windowinfo.ts";

const HELP = [
	"Gamer Sidekick — capture your game window into the conversation.",
	"",
	"  /gs play [exe]     pick a game window to capture",
	"  /gs status        show what is bound and what has been captured",
	"  /gs frames        list frames captured this session",
	"  /gs shot          grab a frame now and report it",
	"  /gs pin [id]      keep a frame in context for every later turn",
	"  /gs unpin [id|all]",
	"  /gs sessions      list saved per-game sessions",
	"  /gs use <slug>    switch to another game's session",
	"  /gs follow <on|off>   track the foreground window instead of a fixed one",
	"  /gs display <n>   force which display to capture from",
	"  /gs setup         check that screen capture works here",
	"  /gs unbind        stop capturing",
	"",
	"Frames are never written to disk. They exist in memory for the turn.",
].join("\n");

export function registerCommands(pi: ExtensionAPI, state: SidekickState): void {
	pi.registerCommand("gs", {
		description: "Gamer Sidekick — capture your game window into the conversation",
		getArgumentCompletions(prefix) {
			const subs = [
				"play", "status", "frames", "shot", "pin", "unpin", "sessions", "use",
				"follow", "display", "setup", "unbind", "help",
			];
			const hits = subs.filter((s) => s.startsWith(prefix));
			return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null;
		},

		async handler(args: string, ctx: ExtensionCommandContext) {
			// The startup probe compiles and queries the Win32 shim. Without this
			// await a command typed immediately after launch reports the package
			// as switched off when it is only still starting up.
			await state.ready;

			const [sub = "help", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ");

			switch (sub) {
				case "help":
				case "":
					ctx.ui.notify(HELP, "info");
					return;
				case "status":
					return cmdStatus(state, ctx);
				case "setup":
					return cmdSetup(state, ctx);
				case "play":
					return cmdPlay(pi, state, arg, ctx);
				case "unbind":
					return cmdUnbind(state, ctx);
				case "frames":
					return cmdFrames(state, ctx);
				case "shot":
					return cmdShot(state, ctx);
				case "pin":
					return cmdPin(state, arg, ctx);
				case "unpin":
					return cmdUnpin(state, arg, ctx);
				case "sessions":
					return cmdSessions(pi, state, ctx);
				case "use":
					return cmdUse(pi, state, arg, ctx);
				case "follow":
					return cmdFollow(state, arg, ctx);
				case "display":
					return cmdDisplay(state, arg, ctx);
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Try /gs help`, "warning");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// /gs status, /gs frames, /gs setup
// ---------------------------------------------------------------------------

function cmdStatus(state: SidekickState, ctx: ExtensionCommandContext): void {
	if (!state.available) {
		ctx.ui.notify(`Gamer Sidekick is off: ${state.disabledReason ?? "still starting up"}`, "error");
		return;
	}
	if (!state.binding) {
		ctx.ui.notify("No game bound. Run /gs play to pick a window.", "info");
		return;
	}

	const b = state.binding;
	const lines = [
		`game      ${b.identity.exe}  (${b.title})`,
		`window    ${formatSize({ width: b.bounds.width, height: b.bounds.height })} at (${b.bounds.x}, ${b.bounds.y})  hwnd ${b.hwnd}`,
		`display   ${b.displayOverride ?? b.display?.index ?? "?"}${b.display ? `  ${b.display.width}x${b.display.height} at (${b.display.x},${b.display.y})` : ""}`,
		`session   ${b.identity.sessionName}`,
		`bound     ${new Date(b.boundAt).toLocaleString()}${b.follow ? "  (following foreground)" : ""}`,
		`frames    ${state.framesCaptured} captured · ${state.framesAttached} attached · ${state.framesDropped} dropped`,
		`pins      ${state.pinned.length > 0 ? state.pinned.join(", ") : "none"}`,
	];
	if (state.lastError) lines.push(`last err  ${state.lastError}`);
	ctx.ui.notify(lines.join("\n"), state.bindingStale ? "warning" : "info");
}

async function cmdSetup(state: SidekickState, ctx: ExtensionCommandContext): Promise<void> {
	const checks: string[] = [];
	checks.push(state.available ? "✓ package loaded" : `✗ ${state.disabledReason}`);

	const probe = await probeCaptureSupport();
	checks.push(probe.ok ? `✓ window enumeration: ${probe.detail}` : `✗ window enumeration: ${probe.detail}`);

	const displays = await resolveDisplays();
	checks.push(
		displays
			? `✓ displays: ${displays.displays.map((d) => `${d.index} (${d.width}x${d.height}@${d.x},${d.y})`).join(", ")}`
			: "⚠ display geometry unavailable — /gs display will be needed",
	);

	if (state.binding) {
		const outcome = await captureFrame(state, "setup");
		checks.push(
			outcome.ok
				? `✓ capture works (${outcome.frame.record.width}x${outcome.frame.record.height}, ${(outcome.frame.record.bytes / 1024) | 0}KB, ${outcome.elapsedMs}ms)`
				: `✗ capture failed: ${describeFailure(outcome.failure)}`,
		);
	} else {
		checks.push("· no window bound yet — run /gs play");
	}

	ctx.ui.notify(checks.join("\n"), state.available && probe.ok ? "info" : "error");
}

function cmdFrames(state: SidekickState, ctx: ExtensionCommandContext): void {
	if (state.frames.length === 0) {
		ctx.ui.notify("No frames captured this session yet.", "info");
		return;
	}
	const rows = state.frames
		.slice(-10)
		.map((f) => {
			const r = f.record;
			const flags = `${r.pinned ? "📌" : "  "} ${r.hash}`;
			return `#${String(r.id).padStart(3, "0")}  ${r.exe}  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(0)}KB  ~${r.imageTokens}tok  ${new Date(r.timestamp).toLocaleTimeString()}  ${flags}`;
		});
	ctx.ui.notify(`Frames captured this session (${state.frames.length}):\n${rows.join("\n")}`, "info");
}

async function cmdShot(state: SidekickState, ctx: ExtensionCommandContext): Promise<void> {
	if (!state.binding) {
		ctx.ui.notify("No game bound. Run /gs play first.", "warning");
		return;
	}
	const outcome = await captureFrame(state, "manual shot");
	if (!outcome.ok) {
		state.lastError = describeFailure(outcome.failure);
		ctx.ui.notify(`No frame: ${state.lastError}`, "warning");
		return;
	}
	const r = outcome.frame.record;
	ctx.ui.notify(`Frame #${String(r.id).padStart(3, "0")} · ${r.width}x${r.height} · ${(r.bytes / 1024).toFixed(0)}KB · ~${r.imageTokens} tokens · ${outcome.elapsedMs}ms. Pin it with /gs pin ${r.id}`, "info");
}

// ---------------------------------------------------------------------------
// /gs play — the binding flow (PRD §6.1)
// ---------------------------------------------------------------------------

async function cmdPlay(pi: ExtensionAPI, state: SidekickState, query: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!state.available) {
		ctx.ui.notify(`Gamer Sidekick is off: ${state.disabledReason ?? "still starting up"}`, "error");
		return;
	}

	const windows = (await listWindows()).filter(isPickableWindow);
	if (windows.length === 0) {
		ctx.ui.notify("No capturable windows found. Run /gs setup to diagnose.", "error");
		return;
	}

	const ordered = sortWindows(filterWindows(windows, query), query);
	// A single match means the user already told us what they meant; do not make
	// them click it again.
	let chosen = ordered[0] as WindowInfo;
	if (ordered.length > 1) {
		const picked = await ctx.ui.select(
			"Which game window?",
			ordered.map(formatWindowChoice),
			// Without a timeout a driver that cannot render the picker (RPC mode,
			// or an IDE integration) waits forever. The default is "nothing picked".
			{ timeout: 180_000 },
		);
		if (!picked) return;
		const index = ordered.map(formatWindowChoice).indexOf(picked);
		chosen = ordered[index] ?? chosen;
	}

	const resolved = await resolveDisplays();
	if (!resolved) {
		ctx.ui.notify("Could not resolve display geometry — capture may be misaligned. /gs display can force one.", "warning");
	} else if (resolved.warning) {
		ctx.ui.notify(resolved.warning, "warning");
	}

	const identity = gameIdentity(chosen.owner?.path || chosen.owner?.name || chosen.title);
	const displays = resolved?.displays ?? [];
	const display = pickDisplayFor(displays, chosen.bounds);

	const binding: Binding = {
		hwnd: chosen.id,
		identity,
		title: chosen.title.trim(),
		bounds: chosen.bounds,
		display: display ?? null,
		boundAt: new Date().toISOString(),
		follow: state.binding?.follow ?? false,
		displayOverride: state.binding?.displayOverride ?? null,
	};

	state.binding = binding;
	state.bindingStale = false;
	pi.appendEntry("gamer_sidekick_binding", {
		exe: identity.exe,
		slug: identity.slug,
		title: binding.title,
		boundAt: binding.boundAt,
	});

	const displayNote = display ? `display ${display.index}` : "display unknown";
	await ensureGameSession(pi, state, ctx, identity);

	ctx.ui.notify(`Capturing ${identity.exe} — "${binding.title}" ${formatSize({ width: binding.bounds.width, height: binding.bounds.height })} on ${displayNote}. Ask a question and the frame comes with it.`, "info");
}

/**
 * Ensure this conversation is the game's own session.
 *
 * Deliberately not automatic on first bind if the player is mid-conversation:
 * starting a new session throws away context they may want. They are asked.
 */
async function ensureGameSession(
	pi: ExtensionAPI,
	state: SidekickState,
	ctx: ExtensionCommandContext,
	identity: ReturnType<typeof gameIdentity>,
): Promise<void> {
	const current = ctx.sessionManager.getSessionName?.() ?? pi.getSessionName();
	if (current === identity.sessionName) return;

	const sessionDir = ctx.sessionManager.getSessionDir();
	const existing = await findSessionFor(sessionDir, identity);

	if (existing) {
		state.sessionSlug = identity.slug;
		await ctx.switchSession(existing.path);
		ctx.ui.notify(`Resumed ${identity.exe} session (${existing.messageCount} messages).`, "info");
		return;
	}

	if (isGameSession(current)) {
		// Currently inside a *different* game's session — safe to leave it.
		state.sessionSlug = identity.slug;
		await ctx.newSession();
		pi.setSessionName(identity.sessionName);
		ctx.ui.notify(`Started a new ${identity.exe} session.`, "info");
		return;
	}

	const start = await ctx.ui.confirm(
		`Start a ${identity.exe} session?`,
		`This conversation is not a game session. Each game gets its own conversation so the model does not mix up ` +
			`games. Starting one leaves this conversation behind.`,
		// Unanswered means no: leaving the conversation in place is recoverable,
		// silently abandoning it is not.
		{ timeout: 180_000 },
	);
	if (start) {
		state.sessionSlug = identity.slug;
		await ctx.newSession();
		pi.setSessionName(identity.sessionName);
	} else {
		// Keep talking here. Binding still works; only the isolation is lost, and
		// the status line keeps saying so.
		state.sessionSlug = identity.slug;
	}
}

// ---------------------------------------------------------------------------
// /gs unbind, pin, unpin, follow, display
// ---------------------------------------------------------------------------

function cmdUnbind(state: SidekickState, ctx: ExtensionCommandContext): void {
	if (!state.binding) {
		ctx.ui.notify("Nothing is bound.", "info");
		return;
	}
	const name = state.binding.identity.exe;
	state.binding = null;
	state.bindingStale = false;
	ctx.ui.notify(`Stopped capturing ${name}.`, "info");
}

function cmdPin(state: SidekickState, arg: string, ctx: ExtensionCommandContext): void {
	const id = Number.parseInt(arg, 10);
	const result = pinFrame(state, Number.isNaN(id) ? undefined : id);
	ctx.ui.notify(result.message, result.ok ? "info" : "warning");
}

function cmdUnpin(state: SidekickState, arg: string, ctx: ExtensionCommandContext): void {
	const trimmed = arg.trim();
	if (trimmed === "" || trimmed === "all") return void ctx.ui.notify(unpinFrame(state, trimmed === "all" ? "all" : undefined).message, "info");
	const id = Number.parseInt(trimmed, 10);
	if (Number.isNaN(id)) return void ctx.ui.notify("Usage: /gs unpin <id|all>", "warning");
	ctx.ui.notify(unpinFrame(state, id).message, "info");
}

function cmdFollow(state: SidekickState, arg: string, ctx: ExtensionCommandContext): void {
	if (!state.binding) {
		ctx.ui.notify("Bind a window first with /gs play.", "warning");
		return;
	}
	const value = arg.trim().toLowerCase();
	if (value !== "on" && value !== "off") {
		ctx.ui.notify(`Follow is ${state.binding.follow ? "on" : "off"}. Usage: /gs follow <on|off>`, "info");
		return;
	}
	state.binding.follow = value === "on";
	ctx.ui.notify(
		state.binding.follow
			? "Follow mode ON — every capture re-resolves the target window. Experimental."
			: "Follow mode OFF — capturing the bound window.",
		"info",
	);
}

function cmdDisplay(state: SidekickState, arg: string, ctx: ExtensionCommandContext): void {
	if (!state.binding) {
		ctx.ui.notify("Bind a window first with /gs play.", "warning");
		return;
	}
	const n = Number.parseInt(arg.trim(), 10);
	if (Number.isNaN(n) || n < 0) {
		const current = state.binding.displayOverride ?? state.binding.display?.index;
		ctx.ui.notify(`Capturing display ${current ?? "?"}. Usage: /gs display <n>`, "info");
		return;
	}
	state.binding.displayOverride = n;
	ctx.ui.notify(`Capturing display ${n}.`, "info");
}

// ---------------------------------------------------------------------------
// /gs sessions, /gs use
// ---------------------------------------------------------------------------

async function cmdSessions(pi: ExtensionAPI, state: SidekickState, ctx: ExtensionCommandContext): Promise<void> {
	const dir = ctx.sessionManager.getSessionDir();
	const sessions = await listGameSessions(dir, ctx.sessionManager.getSessionId());

	if (sessions.length === 0) {
		ctx.ui.notify(`No game sessions saved in ${dir}. Run /gs play to create one.`, "info");
		return;
	}

	const labels = sessions.map((s) => {
		const mark = s.active ? "● " : "  ";
		return `${mark}${s.exe}  ${s.messageCount} msg  ${s.modified.toLocaleString()}  (${s.slug})`;
	});
	const picked = await ctx.ui.select("Game sessions — pick one to switch", labels);
	if (!picked) return;

	const index = labels.indexOf(picked);
	const target = sessions[index];
	if (!target) return;
	if (target.active) {
		ctx.ui.notify("Already in that session.", "info");
		return;
	}
	await ctx.switchSession(target.path);
	state.sessionSlug = target.slug;
	pi.setSessionName(target.name ?? `${SESSION_PREFIX}${target.slug}`);
	ctx.ui.notify(`Switched to ${target.exe}. Rebind its window with /gs play.`, "info");
}

async function cmdUse(pi: ExtensionAPI, state: SidekickState, slug: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!slug.trim()) {
		ctx.ui.notify("Usage: /gs use <slug>  — run /gs sessions to list them", "warning");
		return;
	}
	const dir = ctx.sessionManager.getSessionDir();
	const sessions = await listGameSessions(dir, ctx.sessionManager.getSessionId());
	const needle = slug.trim().toLowerCase();
	const target = sessions.find((s) => s.slug.toLowerCase() === needle || s.slug.toLowerCase().startsWith(needle));

	if (!target) {
		ctx.ui.notify(
			sessions.length > 0 ? `No session matching "${slug}". Known: ${sessions.map((s) => s.slug).join(", ")}` : "No game sessions saved yet.",
			"warning",
		);
		return;
	}
	await ctx.switchSession(target.path);
	state.sessionSlug = target.slug;
	pi.setSessionName(target.name ?? `${SESSION_PREFIX}${target.slug}`);
	ctx.ui.notify(`Switched to ${target.exe}. Rebind its window with /gs play.`, "info");
}

// ---------------------------------------------------------------------------

function pickDisplayFor<T extends { index: number; x: number; y: number; width: number; height: number }>(
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
