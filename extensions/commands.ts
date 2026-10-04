/**
 * The `/gs` command surface. PRD §6.6.1.
 *
 * One command with subcommands, not twelve commands. Slash commands are cheap
 * in pi but each one costs the user a name to remember; `/gs play` and
 * `/gs play` are the same muscle memory.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureFrame } from "./capture.ts";
import { appendBinding } from "./binding.ts";
import { describeFailure, statusText } from "./attach.ts";
import { gameIdentity } from "./identity.ts";
import { rehydrateLedger } from "./ledger.ts";
import { formatSize, type Binding, type SidekickState } from "./state.ts";
import {
	displayFor,
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
	"  /gs frames        list frames captured this conversation",
	"  /gs display <n>   force which display to capture from",
	"  /gs setup         check that screen capture works here",
	"  /gs unbind        stop capturing",
	"",
	"Conversations are yours: /resume, /rename and /new all work normally.",
	"A window stays bound to the conversation you bound it in.",
	"",
	"Every message you send while a window is bound carries a frame into the",
	"conversation, where it stays in context and survives /resume. That costs",
	"disk — roughly 150 KB and ~600 image tokens per frame.",
].join("\n");

export function registerCommands(pi: ExtensionAPI, state: SidekickState): void {
	pi.registerCommand("gs", {
		description: "Gamer Sidekick — capture your game window into the conversation",
		getArgumentCompletions(prefix) {
			const subs = [
				"play", "status", "frames", "display", "setup", "unbind", "help",
			];
			const hits = subs.filter((s) => s.startsWith(prefix));
			return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null;
		},

		async handler(args: string, ctx: ExtensionCommandContext) {
			// The startup probe compiles and queries the Win32 shim. Without this
			// await a command typed immediately after launch reports the package
			// as switched off when it is only still starting up.
			await state.ready;

			// `/gs frames` and `/gs status` describe the conversation, so make
			// them read it rather than this process's memory — otherwise they
			// report zero in a resumed conversation that is full of frames.
			rehydrateLedger(state, ctx.sessionManager.getEntries?.());

			const [sub = "help", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ");

			// Whatever the subcommand did, the status line has to end up telling
			// the truth. It is the only persistent indicator this package has, and
			// nothing refreshes it between commands — so a `/gs play` that
			// succeeded would otherwise keep rendering "no game bound" until the
			// next turn ended, which reads as a failure.
			// `/gs play` sets it on the post-switch context itself; this covers
			// every other subcommand.
			try {
				await runSubcommand(state, sub, arg, ctx);
			} finally {
				ctx.ui.setStatus("gamer-sidekick", statusText(state));
			}
		},
	});
}

async function runSubcommand(
	state: SidekickState,
	sub: string,
	arg: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
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
			return cmdPlay(state, arg, ctx);
		case "unbind":
			return cmdUnbind(state, ctx);
		case "frames":
			return cmdFrames(state, ctx);
		case "display":
			return cmdDisplay(state, arg, ctx);
		default:
			ctx.ui.notify(`Unknown subcommand "${sub}". Try /gs help`, "warning");
	}
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
		`exe       ${b.identity.ownerPath}`,
		`window    ${formatSize({ width: b.bounds.width, height: b.bounds.height })} at (${b.bounds.x}, ${b.bounds.y})  hwnd ${b.hwnd}`,
		`display   ${b.displayOverride ?? b.display?.index ?? "?"}${b.display ? `  ${b.display.width}x${b.display.height} at (${b.display.x},${b.display.y})` : ""}`,
		`bound     ${new Date(b.boundAt).toLocaleString()}`,
		`frames    ${state.framesCaptured} in this conversation · ${state.framesAttached} attached this run · ${state.framesDropped} dropped this run`,
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
	// Reads the ledger, not `state.frames`: the ledger is metadata only and is
	// rebuilt from the conversation on resume, so this lists frames the player
	// actually has even after a restart. `state.frames` is pruned to 8 and
	// would under-report.
	if (state.frameLog.length === 0) {
		ctx.ui.notify("No frames in this conversation yet. Send a message while a game is bound.", "info");
		return;
	}
	const rows = state.frameLog
		.slice(-10)
		.map((r) => `#${String(r.id).padStart(3, "0")}  ${r.exe}  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(0)}KB  ~${r.imageTokens}tok  ${new Date(r.timestamp).toLocaleTimeString()}  ${r.hash}`);
	const older = state.frameLog.length > 10 ? `\n…and ${state.frameLog.length - 10} earlier.` : "";
	ctx.ui.notify(`Frames in this conversation (${state.frameLog.length}):\n${rows.join("\n")}${older}`, "info");
}



// ---------------------------------------------------------------------------
// /gs play — the binding flow (PRD §6.1)
// ---------------------------------------------------------------------------

async function cmdPlay(state: SidekickState, query: string, ctx: ExtensionCommandContext): Promise<void> {
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
	const display = displayFor(displays, chosen.bounds);

	const binding: Binding = {
		hwnd: chosen.id,
		identity,
		title: chosen.title.trim(),
		bounds: chosen.bounds,
		display: display ?? null,
		boundAt: new Date().toISOString(),
		displayOverride: state.binding?.displayOverride ?? null,
	};

	state.binding = binding;
	state.bindingStale = false;

	const displayNote = display ? `display ${display.index}` : "display unknown";
	const stored = {
		exe: identity.exe,
		slug: identity.slug,
		title: binding.title,
		boundAt: binding.boundAt,
	};

	if (!appendBinding(ctx, stored)) {
		// No mutable session manager on this context. Binding works for this
		// session only; say so rather than let it look durable.
		ctx.ui.notify(`Bound for this session only — this pi build will not persist it.`, "warning");
	}
	// The status line is the only persistent indicator this package has, and
	// nothing else refreshes it until a turn ends. Without this it keeps
	// saying "no game bound" right through a bind that succeeded — which reads
	// as a failure and sends the player looking for a second one.
	ctx.ui.setStatus("gamer-sidekick", statusText(state));
	await ctx.ui.notify(
		`Capturing ${identity.exe} — "${binding.title}" ${formatSize({ width: binding.bounds.width, height: binding.bounds.height })} on ${displayNote}. Ask a question and the frame comes with it.`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// /gs unbind, display
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
