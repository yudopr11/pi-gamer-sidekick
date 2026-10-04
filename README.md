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
`~/.pi/agent/settings.json`. **This is the only installation you need** — it
pulls `sharp` and `screenshot-desktop` itself, and gets updates with `pi update`.

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
npm install                # sharp + screenshot-desktop
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

Ask a question. A frame of the bound window is captured as you submit and
attached to that turn.

## How it works

The player alt-tabs to the terminal to type, so a "capture the foreground
window" approach would photograph a text editor. Sidekick therefore binds a
specific window handle and re-validates it before every capture. If you switch
games, run `/gs play` again.

Frames are attached at `before_agent_start` and returned as an ordinary
conversation message, so pi stores them in the session file and hands them back
to the model on later turns and after a `/resume`. A separate metadata entry
records the size, token cost and hash for `/gs frames` and `/gs status`, without
duplicating the image.

## Commands

| Command | Effect |
| --- | --- |
| `/gs setup` | Check that window enumeration and capture both work; report each. |
| `/gs play` | Pick and bind a window. |
| `/gs unbind` | Stop capturing. |
| `/gs status` | What is bound, whether it is still alive, frame counters. |
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
● Sidekick sora_2nd.exe · 2560×1440 · 14 frames · stale
○ Sidekick starting…                         probe still running
× Sidekick <reason>                          capture is not available
```

The glyph is the part worth parsing — green `●` bound, yellow `○` nothing bound
or starting, red `×` broken. Colour appears in TUI mode only, and `NO_COLOR`
turns it off everywhere.

## Frames are part of the conversation

Each time you press `Enter`, the frame lands in the transcript as an ordinary
message with a `[FRAME #001 · …]` caption and the image beside it. That means:

- the model can refer to it on every following turn without anything
  re-sending it;
- it survives `/resume` — pi loads it straight back into the conversation;
- `/gs frames` and the status line count it, including frames captured in an
  earlier process.

What it does *not* mean: pi renders only the text blocks of a custom message,
so you see the caption in your scrollback, not the picture. Asking the model to
look again (`game_frame`, which it will do if you ask) is the way to actually
see one — a tool result is the only thing that renders an image.

The cost is disk. A frame is ~150 KB of base64 in the session file, and ~595
image tokens of context, for every message you send while a window is bound.
Long conversations accumulate; `/compact` is the release valve.

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

`game_frame` — capture now and return the image. `game_window` — metadata about
the bound window, no pixels. Both stay dormant until a window is bound.

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

**Dependencies.** Two: `sharp` (resize/encode/stats) and `screenshot-desktop`
(full-display grab, used only as a fallback when a window cannot render
itself). Both are audited and both were checked clean at the version pinned
here. pi's own packages are `peerDependencies` and are never bundled, so the
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