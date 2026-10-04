# Gamer Sidekick

A pi package that puts a frame of your game window into the conversation.

Ask a question, get the frame that was on screen when you asked. No overlay, no
screenshot gallery, no second monitor.

## Install

```bash
cd path/to/pi-gamer-sidekick
npm install                 # sharp + screenshot-desktop; a local package is never installed by pi itself
pi install C:\path\to\pi-gamer-sidekick
```

`pi install` writes a **local path** declaration into `~/.pi/agent/settings.json`
(personal scope) or `.pi/settings.json` with `--local`. Nothing is copied —
pi loads the extension, prompt and skill straight from the working tree, so
edits take effect on the next start. Use an absolute path: a relative one
resolves against the settings file that holds it, not against your shell.

Check it, remove it:

```bash
pi list                     # confirm the package is registered
pi remove C:\path\to\pi-gamer-sidekick
```

To try it for a single run without touching settings:

```bash
pi -e C:\path\to\pi-gamer-sidekick
```

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

Frames are injected at pi's `context` event rather than by rewriting your
message. `context` is request-local — pi restores conversation state immediately
after — so the images never reach the session file. Your transcripts on disk
carry frame metadata only: id, size, byte count, token cost, timestamp.

## Commands

| Command | Effect |
| --- | --- |
| `/gs setup` | Check that window enumeration and capture both work; report each. |
| `/gs play` | Pick and bind a window. |
| `/gs unbind` | Stop capturing. |
| `/gs status` | What is bound, whether it is still alive, frame counters. |
| `/gs frames` | List captured frames with ids, size and token cost. |
| `/gs display [n]` | Override which display the window is looked for on. |
| `/gs help` | This list. |

## Frames are part of the conversation

Each time you press `Enter`, the frame lands in the transcript as an ordinary
message with a `[FRAME #001 · …]` caption and the image beside it. That means:

- you can see the frame in your scrollback, and refer to it by number later;
- it stays in context on following turns without anything re-sending it;
- `/resume` brings it back with the conversation.

The cost is disk. A frame is ~150 KB of base64 in the session file, and ~595
image tokens of context, for every message you send while a window is bound.
Long conversations accumulate; `/compact` is the release valve.

## Your conversations are yours

This package does not create, rename or switch conversations. `/resume`,
`/rename` and `/new` behave exactly as they always do, and you decide which
game each conversation is about.

A window stays bound to the conversation you bound it in — `/gs play` records
the binding in that conversation, and resuming that conversation resumes
capture. Start a different conversation and it starts unbound; run `/gs play`
there when you want frames in it.

## Model tools

`game_frame` — capture now and return the image. `game_window` — metadata about
the bound window, no pixels. Both stay dormant until a window is bound.

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
npm run check   # tsc --noEmit
npm test        # node:test
```

`scratch/probe-capture.ts` is a standalone end-to-end check: enumerate, bind,
query, capture, and write one JPEG to your temp directory. Run it with
`node --experimental-strip-types scratch/probe-capture.ts`.

## License

MIT