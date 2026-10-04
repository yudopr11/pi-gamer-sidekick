/**
 * Local typings for `screenshot-desktop`.
 *
 * The package ships no `.d.ts` and there is no `@types/*` for it, so without
 * this file every `import("screenshot-desktop")` is an implicit `any` under
 * `strict`. Declaring it here keeps the interop casts in capture.ts honest
 * instead of just silencing TS7016.
 *
 * Shape taken from the package source (v1.15.x): a callable CJS export with
 * `listDisplays` / `all` hung off it.
 */
declare module "screenshot-desktop" {
	import type { Buffer } from "node:buffer";

	export interface ScreenshotOptions {
		/** Write to this path instead of returning a Buffer. */
		path?: string;
		/** Alias of `path`. */
		filename?: string;
		format?: "png" | "jpg";
		/** Display index. IMPORTANT: indexes positionally, 0-based, and cannot be mapped to a display reliably — resolve index→name via `listDisplays()`. */
		screen?: number;
	}

	export interface DisplayInfo {
		id: number;
		name: string;
	}

	export interface ScreenshotDesktop {
		(options?: ScreenshotOptions): Promise<Buffer>;
		/** Display names in index order. Note: no bounds — only `{ id, name }`. */
		listDisplays(): Promise<DisplayInfo[]>;
		/** One Buffer per display. */
		all(): Promise<Buffer[]>;
	}

	const screenshot: ScreenshotDesktop;
	export = screenshot;
}