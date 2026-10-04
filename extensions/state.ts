/**
 * Shared runtime state.
 *
 * One mutable object, owned by extensions/index.ts, passed to every module.
 * The alternative (module-level singletons) makes the capture path untestable
 * and hides the fact that state survives session switches.
 */

import type { GameIdentity } from "./identity.ts";
import type { Size } from "./geometry.ts";

/** A display's geometry, resolved once at bind time. */
export interface DisplayInfo {
	index: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The window this session captures. Persisted per session, never trusted blindly. */
export interface Binding {
	/** Win32 window handle. Recycled by Windows — always revalidated before use. */
	hwnd: number;
	identity: GameIdentity;
	title: string;
	bounds: { x: number; y: number; width: number; height: number };
	display: DisplayInfo | null;
	boundAt: string;
	/** Experimental: re-resolve the target from the foreground window each capture. */
	follow: boolean;
	/** Manual display override from `/gs display <n>`. */
	displayOverride: number | null;
}

/** Metadata for a captured frame. Deliberately contains no pixel data. */
export interface FrameRecord {
	id: number;
	exe: string;
	width: number;
	height: number;
	bytes: number;
	/** First 12 hex chars of the JPEG sha256, for dedupe and provenance. */
	hash: string;
	timestamp: number;
	pinned: boolean;
	/** Estimated OpenAI vision tokens for this frame. */
	imageTokens: number;
	/**
	 * Titles of windows sitting on top of the game when this frame was taken.
	 * Empty or absent means the window captured itself cleanly.
	 */
	coveredBy?: string[];
}

/** An in-memory frame. Never persisted, never written to disk (INV-2). */
export interface Frame {
	record: FrameRecord;
	/** base64 JPEG, ready to become an ImageContent. */
	data: string;
	mimeType: string;
}

/** Why a capture did not produce a frame. Every value maps to a PRD §10 row. */
export type CaptureFailure =
	| { kind: "no-binding" }
	| { kind: "stale-binding" }
	| { kind: "minimized" }
	| { kind: "off-display" }
	| { kind: "black-frame" }
	| { kind: "no-display" }
	| { kind: "disabled"; reason: string };

export interface SidekickState {
	available: boolean;
	/** Why the package disabled itself (non-Windows, missing native module). */
	disabledReason: string | null;

	/**
	 * Resolves when the startup probe has decided availability.
	 *
	 * The probe shells out to PowerShell to build and query the Win32 shim, so
	 * it takes a beat. Anything that reads `available` — commands, tools, the
	 * capture hook — must await this first, or it sees the initial
	 * `available: false, disabledReason: null` and reports the package as
	 * switched off when it is merely still starting.
	 */
	ready: Promise<void>;

	binding: Binding | null;
	/** True while the binding has been found stale at session start. */
	bindingStale: boolean;

	/** Captured this session. */
	frames: Frame[];
	/** Pinned frame ids, oldest first. Bounded by MAX_PINNED_FRAMES. */
	pinned: number[];
	nextFrameId: number;

	/** The frame captured for the turn currently in flight. */
	pendingFrame: Frame | null;

	framesCaptured: number;
	framesAttached: number;
	framesDropped: number;

	autoswitch: boolean;
	promptHintShown: boolean;

	lastError: string | null;
	/** Slug of the game this session is bound to, for session-switch detection. */
	sessionSlug: string | null;
}

export function createState(): SidekickState {
	return {
		available: false,
		disabledReason: null,
		ready: Promise.resolve(),
		binding: null,
		bindingStale: false,
		frames: [],
		pinned: [],
		nextFrameId: 1,
		pendingFrame: null,
		framesCaptured: 0,
		framesAttached: 0,
		framesDropped: 0,
		autoswitch: false,
		promptHintShown: false,
		lastError: null,
		sessionSlug: null,
	};
}

/** Reset per-session state. Keeps user preferences (autoswitch) across sessions. */
export function resetSessionState(state: SidekickState): void {
	state.binding = null;
	state.bindingStale = false;
	state.frames = [];
	state.pinned = [];
	state.nextFrameId = 1;
	state.pendingFrame = null;
	state.framesCaptured = 0;
	state.framesAttached = 0;
	state.framesDropped = 0;
	state.lastError = null;
}

/** Find a captured frame by id. */
export function findFrame(state: SidekickState, id: number): Frame | undefined {
	return state.frames.find((f) => f.record.id === id);
}

/** Metadata only — safe to hand to `pi.appendEntry`. */
export function toRecord(frame: Frame): Omit<FrameRecord, "pinned"> {
	const { pinned: _pinned, ...rest } = frame.record;
	return rest;
}

/** Compact human-readable size for the status line. */
export function formatSize(size: Size): string {
	return `${size.width}x${size.height}`;
}
