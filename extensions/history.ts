/** Opt-in rolling frame snapshots. Pixels stay in this process's RAM only. */

import { captureFrame } from "./capture.ts";
import type { Frame, SidekickState } from "./state.ts";

export const HISTORY_LIMIT = 60;
export const HISTORY_INTERVAL_MS = 1_000;
export const HISTORY_RETURN_LIMIT = 3;

export function startHistory(state: SidekickState): void {
	if (!state.binding) return;
	state.historyEnabled = true;
	if (state.historyTimer) return;
	state.historyTimer = setInterval(() => {
		void sampleHistory(state);
	}, HISTORY_INTERVAL_MS);
	state.historyTimer.unref?.();
}

export function stopHistory(state: SidekickState): void {
	state.historyGeneration++;
	state.historyEnabled = false;
	if (state.historyTimer) clearInterval(state.historyTimer);
	state.historyTimer = null;
	state.historyFrames = [];
}

export async function sampleHistory(
	state: SidekickState,
	capture: typeof captureFrame = captureFrame,
): Promise<void> {
	if (!state.historyEnabled || !state.binding || state.historyCaptureInFlight) return;
	const generation = state.historyGeneration;
	state.historyCaptureInFlight = true;
	try {
		const outcome = await capture(state, { record: false });
		if (outcome.ok && state.historyEnabled && state.binding && generation === state.historyGeneration) {
			state.historyFrames.push(outcome.frame);
			while (state.historyFrames.length > HISTORY_LIMIT) state.historyFrames.shift();
		}
	} catch {
		// Background sampling must never interrupt a user's turn.
	} finally {
		state.historyCaptureInFlight = false;
	}
}

/** Select no more than three evenly spaced snapshots, oldest to newest. */
export function selectHistoryFrames(frames: Frame[]): Frame[] {
	const count = Math.min(HISTORY_RETURN_LIMIT, frames.length);
	if (count === 0) return [];
	if (count === 1) return [frames[frames.length - 1]!];
	return Array.from({ length: count }, (_, i) => frames[Math.floor(i * (frames.length - 1) / (count - 1))]!);
}
