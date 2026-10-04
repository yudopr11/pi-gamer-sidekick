/**
 * Terminal styling for the footer status line.
 *
 * ## Why raw escape codes
 *
 * pi renders `ctx.ui.setStatus` through pi-tui, which is ANSI-aware: the
 * footer calls `truncateToWidth(statusLine, width, …)`, which measures with
 * `visibleWidth`, and that walks escape sequences with `ansiCodeLength`
 * instead of counting them. Colour therefore costs no visible width, and a
 * narrow terminal cannot truncate one in half.
 *
 * On the pi side, `sanitizeStatusText` only rewrites `\r`, `\n`, `\t` and
 * collapses runs of spaces — styling passes through untouched. That collapse is
 * the catch: **alignment cannot be done with padding spaces**, so hierarchy has
 * to come from colour and weight instead of layout.
 *
 * Chalk is pi's dependency, not ours. An extension must not bundle its host's
 * packages (duplicate class registries), and importing chalk from a package
 * that does not declare it would break the moment pi restructures its node
 * modules. So: the eight escapes we actually need, by hand.
 *
 * ## When to emit colour
 *
 * Only when something is watching. `NO_COLOR` wins over everything, per the
 * informal standard; then `FORCE_COLOR`; then "is stdout a TTY". In RPC mode
 * the status text is forwarded to the host as an `extension_ui_request` event,
 * where escape codes would be noise, and stdout there is a pipe.
 */

/** Per https://no-color.org — present and not empty means off. */
function disabledByEnv(): boolean {
	const env = process.env;
	if (env.NO_COLOR) return true;
	// An empty `FORCE_COLOR=` is a shell accident, not an instruction: treat it
	// as unset rather than letting it force colour on.
	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") {
		return env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false";
	}
	if (env.TERM === "dumb") return true;
	return !process.stdout?.isTTY;
}

/**
 * Read from the environment per call rather than cached at import: the status
 * line renders a handful of times a turn, and a cache would make the output
 * untestable without a subprocess.
 */
export function colorEnabled(): boolean {
	return !disabledByEnv();
}

/**
 * Whether to emit escapes right now.
 *
 * `setPaint` lets the extension override the environment-derived answer with
 * what pi is actually doing. `ctx.mode` is the authoritative signal: pi in
 * `rpc`, `json` or `print` mode is not drawing a terminal, and passing escape
 * codes to a GUI host that will render the text literally is worse than
 * passing none. `process.stdout.isTTY` gets this right in practice — the
 * extension shares pi's process — but it is an inference, and this is not a
 * place to be wrong in a way nobody can see.
 */
let paint: boolean | null = null;

/** `null` restores the environment-derived default. */
export function setPaint(enabled: boolean | null): void {
	paint = enabled;
}

function on(): boolean {
	return paint ?? colorEnabled();
}

const RESET = "\x1b[0m";

function wrap(open: number, text: string): string {
	return on() ? `\x1b[${open}m${text}${RESET}` : text;
}

/** Recedes. For the wordmark and the separators. */
export const dim = (text: string): string => wrap(2, text);

/** Draws the eye. For the thing the player actually bound. */
export const bold = (text: string): string => wrap(1, text);

/** Live and healthy. */
export const green = (text: string): string => wrap(32, text);

/** Bound, but something wants attention. */
export const yellow = (text: string): string => wrap(33, text);

/** Broken. */
export const red = (text: string): string => wrap(31, text);

/** An instruction the player can act on. */
export const underline = (text: string): string => wrap(4, text);