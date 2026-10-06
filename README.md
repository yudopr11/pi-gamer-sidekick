# Gamer Sidekick

A pi package that puts a frame of your game window into the conversation.

Ask a question, get the frame that was on screen when you asked. No overlay, no
screenshot gallery, no second monitor.

## Install

### From GitHub (recommended)

```bash
pi install git:github.com/yudopr11/pi-gamer-sidekick
```

pi clones the repo, runs `npm install` for it and registers it in
`~/.pi/agent/settings.json`. **This is the only installation you need.** The
package has no runtime dependencies, so there is no `node_modules` at all — the
clone is about 780 KB, of which roughly 190 KB is what pi actually loads.
Updates come with `pi update`.

Verify, update, remove:

```bash
pi list                                                   # is it registered
pi update --extensions                                    # pull a newer revision
pi remove git:github.com/yudopr11/pi-gamer-sidekick
```

### From a local clone

Useful while you are working on it — pi loads the extension, prompt and skill
straight from the working tree, so edits take effect on the next start.

```bash
cd path/to/pi-gamer-sidekick
npm install                # dev only: typescript and pi's SDK, for the tests
pi install C:\path\to\pi-gamer-sidekick
pi -e C:\path\to\pi-gamer-sidekick    # or: try it for one run only
```

A local package is **never** installed or updated by pi — `npm install` in that
directory is yours to run, and its dependencies are yours to keep current.
Because nothing is copied, an absolute path matters: a relative one resolves
against the settings file that holds it, not against your shell.

`pi remove C:\path\to\pi-gamer-sidekick` unregisters it.

Then, in a session:

```
/gs setup     # confirm capture works on this machine
/gs play      # pick the game window to watch
```

Ask a question. By default, the model captures a frame only when it needs the
screen to answer. You can opt into 1 fps RAM-only rolling history with
`/gs history on`.

## How it works

The player alt-tabs to the terminal to type, so a "capture the foreground
window" approach would photograph a text editor. Sidekick therefore binds a
specific window handle and re-validates it before every capture. If you switch
games, run `/gs play` again.

With rolling history off (the default), frames are not taken on every message.
The model calls `game_frame` when the answer depends on what is on screen — a
question about lore, a build or a boss costs nothing at all. Whichever way a
frame arrives, a separate metadata entry records its size, token cost and hash
for `/gs frames` and `/gs status`, without duplicating the image.

## Commands

| Command | Effect |
| --- | --- |
| `/gs setup` | Check that window enumeration and capture both work; report each. |
| `/gs play` | Pick and bind a window. |
| `/gs unbind` | Stop capturing. |
| `/gs auto [on\|off]` | `on`: it looks when the answer needs the screen (default). `off`: every message carries a frame. |
| `/gs history on\|off` | Keep up to 60 recent frames in RAM at 1 fps for context in `game_frame` (default off). |
| `/gs status` | What is bound, whether it is still alive, capture mode, frame counters. |
| `/gs frames` | List frames in this conversation with ids, size and token cost. |
| `/gs display [n]` | Override which display the window is looked for on. |
| `/gs help` | This list. |

## The status line

pi's footer carries one line for this package, colour-coded so it can be read
without focusing on it:

```
○ Sidekick no window · /gs play              nothing bound yet
● Sidekick sora_2nd.exe · 2560×1440          bound, nothing captured yet
● Sidekick sora_2nd.exe · 2560×1440 · 14 frames
● Sidekick sora_2nd.exe · 2560×1440 · 14 frames · every message
● Sidekick sora_2nd.exe · 2560×1440 · 14 frames · stale
○ Sidekick starting…                         probe still running
× Sidekick <reason>                          capture is not available
```

The glyph is the part worth parsing — green `●` bound, yellow `○` nothing bound
or starting, red `×` broken. Colour appears in TUI mode only, and `NO_COLOR`
turns it off everywhere.

## Nothing is photographed until it is needed

With rolling history off, pressing `Enter` does not capture anything. The
companion sees nothing at all until it calls `game_frame`, and it is told to
call it when the answer depends on the screen — what just happened, where you
are, what a menu or status screen says, what changed since the last look — and
to answer without it when the question is about the game rather than the screen.
When enabled with `/gs history on`, the bound game window is sampled once per
second into a RAM-only buffer; only a few selected frames are sent when
`game_frame` is called.

The reason is simple arithmetic. A frame is ~150 KB of base64 in the session
file and ~595 image tokens of context. Three questions about lore in the same
room used to cost three identical screenshots of that room. Now they cost
nothing, and only the question that needed the screen spends a capture.

What you get in return:

- the picture is actually **visible**. pi renders only the text blocks of a
  custom message, so the old automatic path reached the model and left you a
  caption. A tool result is rendered — asking for a frame is the only way in this
  package to see the game;
- every frame stays in the conversation, so it survives `/resume` and the model
  can refer back to it by number;
- `/gs frames` and the status line count them, including frames taken in an
  earlier process.

The cost is a round trip on the turns that do need a frame, and the model's
willingness to reach for the tool. If you would rather not depend on that,
`/gs auto off` puts a frame on every message the way it worked before, and the
status line says `· every message` so you know which mode you are in.

## Looking things up

The frame tells you what is on screen. Web search tells you everything else —
item recipes, quest names, map locations, boss strategy, party composition,
lore, what a specific error means. If a package providing web search is
installed, the companion uses it: your game questions get current, sourced
answers instead of whatever the model happens to remember, which for a
patched game is often wrong.

It never searches for what is in the frame. Identifying a scene by looking it
up is how you end up confidently describing a screenshot of a different version
of the game. When a wiki and the frame disagree, the frame wins for your game
and the companion says which one it believes.

If no web tool is installed or enabled, the companion says so rather than
answering from memory as if it had checked.

## Your conversations are yours

This package does not create, rename or switch conversations — that is pi's
business, and you decide which game each conversation is about.

A window is bound to the conversation you bound it in: `/gs play` records the
binding in that conversation, and coming back to that conversation brings the
binding with it. Start a different conversation and it starts unbound; run
`/gs play` there when you want frames in it.

## Model tools

`game_frame` — take a screenshot of the bound window now and return the image.
`game_window` — metadata about the bound window, no pixels. Both stay dormant
until a window is bound.

## Security

No telemetry, no analytics, no network calls — the package itself makes none.
Anything that leaves your machine does so through pi, to whatever model you
have configured.

**It compiles C# the first time you run it.** There is no prebuilt binary in the
repo. `extensions/win/bootstrap.ps1` feeds `extensions/win/win32.cs` to
`Add-Type`, which builds `gs_win32.dll` beside it and stamps the build so it
compiles again only when the source changes. The scripts run with
`-ExecutionPolicy Bypass`, which is scoped to that one invocation rather than
loosened machine-wide. The C# is 219 lines of P/Invoke and does no network
access, launches no processes, touches no registry and writes no files — read
it, it is not a black box.

**No shell is ever involved.** Window queries go through `execFile` with an
argument vector, never `exec`, so there is nothing for a value to be escaped
into. Script names are string literals in the source. The single argument is a
window handle, and the PowerShell side casts it to `[long]`, which throws
rather than executing anything.

**What it can see.** Every visible top-level window's title and process path —
that is what makes `/gs play`'s picker possible — and the pixels of the one
window you bind. Nothing else is read. The package never writes an image to
disk; frames become base64 inside pi's own session file, which is yours to
delete or compact. (`scratch/probe-capture.ts` is a development probe and
writes a JPEG to `%TEMP%` so you can eyeball the pipeline; it is not part of
the package and never runs unless you type its command.)

**Dependencies.** None at runtime, and that is a deliberate decision rather
than an accident.

The obvious way to build this is `sharp` for scaling and encoding plus
`screenshot-desktop` for the fallback grab. That is what it did first. Then it
was measured: `libvips-42.dll`, which `sharp` installs, is **19 MB — 86% of the
whole package**. The other 164 KB was the code.

But the package already compiles a C# shim to talk to Windows, and Windows can
already do exactly the three things `sharp` was doing here: `Graphics.DrawImage`
to scale, an `EncoderParameters.Quality` to encode, and `LockBits` to compute the
mean red channel that the black-frame check needs. Moving that work into the
shim took the install from **22 MB to 780 KB**, with no `node_modules` at all.

The reason it is worth doing is the boundary, not just the bytes. `PrintWindow`
renders a 2560x1440 window; as a PNG that is 5.9 MB of base64 crossing out of
PowerShell into JavaScript, only to be decoded, cropped, resized and re-encoded
into the ~150 KB frame that actually gets sent. The finished frame is now the
only thing that ever crosses.

What was given up: `libvips` is a better JPEG encoder than GDI+. Sizes at the
same quality number shift a little. Nothing this package used was lost — it only
ever went PNG in, JPEG out, plus one statistics read.

pi's own packages remain `peerDependencies` and are never bundled, so the
package cannot end up shipping a second copy of your agent.

## Limits

- **Windows only.** The window enumeration shim is a small P/Invoke library
  built on first use.
- **Borderless and windowed.** Exclusive fullscreen usually yields a black frame
  through a desktop-grab path. The question is still answered; only the picture
  is missing, and the reason is stated.
- **Text only.** The companion cannot draw on your screen or drive the game.
- **Single-player, offline and PvE.** Competitive online titles are out of scope.

## Development

```
npm install
npm run check   # tsc --noEmit, extensions + tests + scratch
npm test        # node:test
```

`scratch/` holds three live probes that drive a real pi process against a real
game window. They need a game running, so they are not part of `npm test`:

| Probe | Question it answers |
| --- | --- |
| `probe-capture.ts` | Does the capture pipeline work at all here? No pi needed. |
| `probe-conversation.ts` | Does the frame land in the conversation as a real message? |
| `probe-resume.ts` | Does the frame come back after `/resume`, and do the counters agree? |

```
node --experimental-strip-types scratch/probe-capture.ts
```

## License

MIT