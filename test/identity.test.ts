import { test } from "node:test";
import assert from "node:assert/strict";
import { gameIdentity, matchesExe } from "../extensions/identity.ts";

test("derives the exe basename and lowercases it", () => {
	const id = gameIdentity("C:\\Program Files (x86)\\Steam\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe");
	assert.equal(id.exe, "eldenring.exe");
});

test("tolerates posix separators", () => {
	assert.equal(gameIdentity("/home/kid/games/celeste/celeste.exe").exe, "celeste.exe");
});

test("same exe at different paths yields different slugs", () => {
	const a = gameIdentity("C:\\Steam\\eldenring.exe");
	const b = gameIdentity("D:\\Backup\\eldenring.exe");
	assert.notEqual(a.slug, b.slug, "two installs must not share a conversation");
	assert.equal(a.sessionName, `gamer-sidekick/${a.slug}`);
	assert.equal(b.sessionName, `gamer-sidekick/${b.slug}`);
});

test("same path yields a stable slug", () => {
	const a = gameIdentity("C:\\Steam\\eldenring.exe");
	const b = gameIdentity("C:\\Steam\\eldenring.exe");
	assert.equal(a.slug, b.slug);
});

test("slug is filename safe", () => {
	const id = gameIdentity("C:\\Games\\Some Game (2024) [v1.2.3]\\Some Game!.exe");
	assert.match(id.slug, /^[a-z0-9._-]+$/);
	assert.ok(id.slug.length <= 40 + 1 + 8, `slug too long: ${id.slug}`);
});

test("slug keeps the .exe extension readable", () => {
	const id = gameIdentity("C:\\Steam\\eldenring.exe");
	assert.ok(id.slug.startsWith("eldenring.exe-"), id.slug);
});

test("unusable basename degrades instead of throwing", () => {
	const id = gameIdentity("   ");
	assert.equal(id.exe, "unknown");
	assert.match(id.slug, /^game-[0-9a-f]{8}$/);
});

test("empty session name is never produced", () => {
	for (const p of ["", "/", "\\\\", "   ", "C:\\\\"]) {
		const id = gameIdentity(p);
		assert.ok(id.sessionName.startsWith("gamer-sidekick/"), p);
		assert.ok(id.sessionName.length > "gamer-sidekick/".length, p);
	}
});

test("matchesExe accepts bare name, full name, and full path", () => {
	const id = gameIdentity("C:\\Steam\\eldenring.exe");
	assert.ok(matchesExe(id, "eldenring"));
	assert.ok(matchesExe(id, "eldenring.exe"));
	assert.ok(matchesExe(id, "ELDENRING.EXE"));
	assert.ok(matchesExe(id, "C:\\Other\\eldenring.exe"));
	assert.ok(!matchesExe(id, "cyberpunk2077"));
	assert.ok(!matchesExe(id, ""));
	assert.ok(!matchesExe(id, "ring"));
});
