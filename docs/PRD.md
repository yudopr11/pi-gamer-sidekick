# Gamer Sidekick — Product Requirements Document

## Document Control

| Field | Value |
| --- | --- |
| Product | **Gamer Sidekick** (was: Sidekick) |
| Version | **0.1.0** (built and running) |
| Package | `pi-gamer-sidekick` (npm, keyword `pi-package`) |
| Date | 2026-10-04 |
| Status | **Built.** §0 amendments below are the current behaviour; sections after §0 that they supersede are kept as the design history they were. |
| Supersedes | ~~Sidekick 1.2.0 (standalone Tauri app)~~ → [`PRD-standalone-tauri.md`](./PRD-standalone-tauri.md) (**deprecated**, retained for history) |
| Target platform | **Windows 10 1809+ / Windows 11 (x64)** |
| Delivery form | **A pi package.** No standalone binary. No installer. No Rust. No WebView. |
| AI provider | Whatever pi is configured with — recommended **OpenAI** via `OPENAI_API_KEY`, `openai-responses` API |
| Default model | **Cheapest vision-capable model available in pi.** Recommended `gpt-6-luna` ($0.10 in / $0.50 out per 1M) |
| Intended games | **Single-player, offline, and PvE/co-op titles. Not competitive or online multiplayer (§9).** |
| Repository | `git`, branch `main`, package root is the repo root |
| Amendment | **A2 (owner, 2026-10-04)** — frames are ordinary conversation messages; `/gs pin`, `/gs unpin` and `/gs shot` are **withdrawn**. See [§0 Amendments](#0-amendments). |

---

## 0. Amendments

### A1 — Conversations belong to the player (owner decision, 2026-10-04)

**Withdrawn:** per-game sessions, auto-switching, auto session naming, `/gs game`,
`/gs games`, `/gs use`, `/gs autoswitch`, and `/gs follow` (foreground targeting).

**Why.** The player asked for the opposite of what the draft assumed. They want to
resume whichever conversation they like with pi's own `/resume`, and they name their
own conversations. A package that silently creates, renames and switches conversations
competes with the thing the player is already good at, and every one of those
behaviours has to survive the fact that replacing a conversation re-runs the
extension and rebuilds its state from scratch — which is how the original
`/gs play` lost its binding.

**What it means now.**

- `/gs play` binds a window **in the current conversation** and stops. No switch, no prompt.
- The binding is written to that conversation's own entries, so `/resume`-ing it restores capture.
- Starting or switching to another conversation gives you an unbound conversation. Run `/gs play` there when you want frames in it. This is a consequence of pi re-running extensions on session replacement, not a policy.
- `/gs status` prints the exe path instead of a session name.
- `GameIdentity` lost its `sessionName` field. The slug is still used to key frames.

**Kept.** `/gs follow` went for a second, independent reason: the player alt-tabs to pi
to type, so the foreground window *is* the terminal. Foreground targeting could only
ever have been right under a picture-in-picture overlay this package does not have.
The bound handle is re-validated on every capture instead, which is what §6.2.1
already did.

### A2 — Frames are ordinary conversation messages (owner decision, 2026-10-04)

**Withdrawn:** `/gs pin`, `/gs unpin`, `/gs pins`, `/gs compare`, `/gs shot`, the
whole pinning mechanism, and the request-local `context` injection that §6.3
originally specified.

**Why.** The player can already see the frame in the terminal, so pinning is a
second mechanism doing a job the transcript already does. And they asked for the
frame to be *in* the conversation rather than in a request — which is the
opposite of what G-D4 optimised for.

**What it means now.**

- `before_agent_start` returns `{ message }` carrying the caption and the
  `ImageContent`. pi appends it to the conversation after the question, maps it
  to a user message for the provider (`convertToLlm`, `case "custom"`), persists
  it as a top-level `custom_message` entry, and renders it when `display: true`.
- Frames stay in context on later turns for free. Nothing re-sends them.
- There is no pin budget, no frame budget and no idempotence guard — one capture
  per turn, once, in `before_agent_start`, which fires once per agent loop.

**The cost, stated plainly.** INV-2 is **reversed**. A frame is now a session
entry, so its base64 lands in the conversation file: ~150 KB and ~595 image
tokens per turn, for as long as a window is bound. This is the price of a frame
you can scroll back to. `/compact` is the release valve.

**Measured** (live, `scratch/probe-conversation.ts`, Trails in the Sky 2nd
Chapter): `234742 custom_message | customType=gamer_sidekick_frame display=true
blocks="text,image(234336b)"` in a 271 KB session file, and the model answered
with a correct reading of the on-screen fishing minigame.

**Superseded:** G-D4, INV-2, AC-GS-09, §6.3.2, §6.4 (entirely), §6.8's pin rows,
E8, G-D5, G-O3.

**Correction, same day.** The rationale above said a frame "renders in the
terminal, which is why the player can see it". That is false and was caught by
reading pi's `CustomMessageComponent`:

```js
this.message.content.filter(c => c.type === "text").map(c => c.text).join("")
```

Text blocks only. The picture reaches the model; the player sees the caption.
The same renderer handles a live turn and a resumed one, so nothing regressed —
it never rendered. Only *tool results* render images (`settings.terminal.showImages`,
default on), and there is no extension API for injecting one, which is why
`game_frame` is retained: it is the only path that puts a picture on screen.

**Follow-up defect, same day.** `state` is rebuilt on every conversation
replacement, so after `/resume` the status line reported `0 frames` and
`/gs frames` said none had been captured — for a conversation pi had *already*
loaded frames from and was feeding to the model. The images were accounted for;
only the bookkeeping was missing. Fixed by `extensions/ledger.ts`, which rebuilds
a metadata-only ledger (`FrameRecord` rows, last 50) from the conversation's
custom entries at `session_start`, before each `/gs` subcommand and before each
turn's capture. `framesCaptured` is a monotonic conversation total;
`/gs status` splits it from the per-run attached/dropped counters so "1 in this
conversation · 0 attached this run" is unambiguous.
---

## 1. What This Is — TL;DR

**Gamer Sidekick is a pi package that teaches pi to see your game.**

You keep pi open in a second window. You alt-tab to it, type a question about the game you are playing, press `Enter`. The package captures the current frame of the game window you bound to this session, attaches it to your question as an image, and pi answers it with a vision model — streamed, with per-game conversation memory and automatic context compaction.

```
  Elden Ring (1920x1080)          pi (terminal)
  ┌───────────────────┐            ┌──────────────────────────────┐
  │                   │  alt-tab   │ > what am I supposed to do    │
  │   [the fight]     │ ────────▶  │   here?                      │
  │                   │            │                              │
  └───────────────────┘            │ [FRAME #014 · eldenring.exe]  │
                                   │ Bound to game: eldenring.exe  │
                                   │                              │
                                   │ Bind the window once with      │
                                   │   /gs play                    │
                                   └──────────────────────────────┘
```

Everything the hard part of the agent needs — image attachment, streaming, sessions, compaction, token accounting, slash commands, model selection — **already exists in pi**. Gamer Sidekick supplies only what pi does not have: *knowing which window is the game, grabbing its pixels, and injecting the frame at exactly the right moment.*

---

## 2. Why a pi package (and what was abandoned)

The previous PRD specified a standalone Rust + Tauri v2 desktop application. Full reasoning in [`PRD-standalone-tauri.md`](./PRD-standalone-tauri.md); the short version:

| Concern | Standalone app would build | pi already provides |
| --- | --- | --- |
| Image attachment to a prompt | Manual base64 + `ImageContent` construction | `ImageContent` on `prompt`/`sendUserMessage`, `before_agent_start.images` |
| Token streaming to the UI | Own SSE client + event emitter | `message_update` → `assistantMessageEvent.type === "text_delta"` |
| Conversation persistence | Own JSONL schema, branching, resume | Session tree, `--session`, `/resume`, `newSession`/`fork`/`switchSession` |
| **Context compaction** | Own digest algorithm, thresholds, retry, atomic commit | Automatic + manual compaction, compaction events, transcript never mutated |
| Model list + filter | Own regex allowlist/denylist + pricing table | `get_available_models`, `set_model`, `Usage.cost` per request |
| Slash commands | Own parser + dispatch | `pi.registerCommand()` |
| Request lifecycle hooks | n/a | `before_agent_start`, `context`, `tool_call`, `turn_end`, … |

**What pi genuinely cannot do**, and therefore remains in scope for Gamer Sidekick:

1. **Know which window is the game.** Pi has no Win32 window enumeration.
2. **Capture pixels.** Pi has no screen capture.
3. **Be triggered without focus.** `pi.registerShortcut()` is a *TUI keybinding* — it only fires when the pi terminal itself has keyboard focus. In RPC mode `onTerminalInput()` is a documented no-op. A hotkey that fires while a game is focused is impossible from inside pi's process.

Those three are the entire product surface.

---

## 3. Product Vision

A companion that has **memory of your playthrough**. It is not a chatbot you re-explain your build to; it is a coach that has been sitting in the corner of your screen all evening, remembers what you tried ten minutes ago, and knows what the boss is doing right now.

Three properties make it feel like that, in priority order:

1. **The frame is always current.** The screenshot is taken at the instant you press `Enter` — the exact frame you were looking at when the question formed. This is the whole product.
2. **The conversation is per game.** Elden Ring's thread is not Cyberpunk's thread. Reopen the game, reopen its thread, pick up mid-fight.
3. **It never forgets, and never bloats.** Old turns compact away invisibly; your scrollback transcript is never rewritten.

---

## 4. Goals and Non-Goals

### 4.1 Goals (v0.1.0)

| ID | Goal | Measured by |
| --- | --- | --- |
| G1 | Ask a question about the game currently on screen and get a vision-grounded answer | AC-GS-01 |
| G2 | The attached frame is the frame you were looking at when you pressed `Enter` | AC-GS-02 |
| G3 | A game process has a conversation you can resume, with its binding and its frames intact | AC-GS-03 |
| G4 | Frame bytes reach only the conversation you asked in, and only while a window is bound | AC-GS-04 |
| G5 | Zero configuration beyond `pi install` + `/gs play` | AC-GS-05 |
| G6 | Attach cost is bounded and visible | AC-GS-06 |
| G7 | The package adds no meaningful idle CPU or memory to pi | AC-GS-07 |

### 4.2 Non-Goals (v0.1.0)

Explicitly **not** built. Anything here needs a new PRD.

- ❌ **Overlay window.** No floating window over the game. You alt-tab to pi. (This is the single biggest scope reduction from the deprecated PRD — see §11 R-1.)
- ❌ **System tray, autostart, installer, `sidekick.exe`.** You run pi. That is the app.
- ❌ **Global hotkey.** Unreachable from inside a pi package (§2, item 3).
- ❌ **Rust, Tauri, WebView, React.** The UI is pi's TUI.
- ❌ **Voice, audio, or game memory reading.** No `ReadProcessMemory`, no DLL injection, no hooks, no input automation. The package sees **pixels and window titles only**.
- ❌ **Macro/coaching automation.** No click automation, no build orders, no pixel-reading stat trackers.
- ❌ **Multiplayer / competitive titles.** (§9)
- ❌ **macOS / Linux support.** Windows-only in v0.1.0; the code must not crash elsewhere (§6.1.4).

---

## 5. User Flow

```
   pi install npm:pi-gamer-sidekick
              |
              v
   +------------------------------------------+
   | First prompt in a pi session             |
   | Gamer Sidekick detects: no bound game    |
   | -> inline notice + /gs play hint         |
   +------------------------------------------+
              |
              v
   +------------------------------------------+
   | /gs play                                  |
   | -> lists open windows (exe, title, bounds)|
   | -> user picks "eldenring.exe - ELDEN     |
   |    RING"                                  |
   | -> window bound to THIS conversation     |
   | -> binding recorded in that conversation |
   |    (conversations stay yours — §0 A1)    |
   +------------------------------------------+
              |
              v
   +------------------------------------------+
   | Gameplay. User alt-tabs to pi.           |
   |                                          |
   | > what's it doing in phase 2?            |
   |   [FRAME #014 · eldenring.exe 1920x1080]  |
   |   (attached silently, question answered)  |
   |                                          |
   | > *answers*                              |
   |                                          |
   | > what about if I dodge left?            |
   |   [FRAME #015 · eldenring.exe 1920x1080]  |
   |   ...conversation continues, remembers   |
   |   phase 2 from two turns ago             |
   +------------------------------------------+
              |
              v
   +------------------------------------------+
   | /gs pin        -> keep frame #015        |
   | /gs frames     -> what has been captured |
   | /gs status     -> window, model, context |
   | /gs play <n>   -> rebind to another game |
   | /gs unbind     -> stop capturing         |
   +------------------------------------------+
```

**Invariant INV-1:** capturing never blocks, delays, or degrades the user's game. Capture happens only after `Enter`, on the pi thread, never on the game's thread.

~~**Invariant INV-2:** Gamer Sidekick never writes frame pixels to any file, anywhere, ever.~~ **REVERSED by A2** — frames are conversation entries, so their bytes are written to the session file on purpose.

**Invariant INV-3:** Gamer Sidekick is inert until a game window is bound. It never captures your screen because it felt like it.

---

## 6. Functional Requirements

### 6.1 Window Binding and Detection

#### 6.1.1 The core problem

The obvious design — "capture the foreground window when the user hits `Enter`" — **is wrong**, and this PRD deliberately rejects it.

To type a question, the user has alt-tabbed to the terminal. At the moment of capture, the foreground window is **Windows Terminal**, not the game. Foreground capture would send a picture of a text editor to a vision model.

Therefore: **the capture target is an explicitly bound window, identified by its Win32 handle, resolved at capture time from a cached window list — never by querying the foreground window at prompt time.**

#### 6.1.2 Binding

| Aspect | Requirement |
| --- | --- |
| Command | `/gs play` with no argument opens a window picker |
| Picker source | `openWindows()` from `active-win@9.0.0` — full window list with `title`, `id` (HWND), `bounds`, `owner.name`, `owner.path`, `owner.processId` |
| Picker UI | `ctx.ui.select()` with a filtered list, e.g. `[eldenring.exe] ELDEN RING  1920x1080 @ (0,0)` |
| Filtering | Exclude zero-size windows, the terminal running pi itself, and the desktop shell. Sort: exact executable-name matches first, then largest area |
| Direct bind | `/gs play eldenring` binds without the picker when exactly one window matches |
| Rebind | `/gs play <n>` where `n` is an index from the last picker listing |
| Unbind | `/gs unbind` clears the binding; the session becomes text-only |
| Bound state | Persisted in the session as a `gamer_sidekick_binding` custom entry (`pi.appendEntry`), so a resumed session knows its window |
| Persistence | The HWND is **session-scoped and not trusted across pi restarts** (handles are recycled by Windows). On `session_start`, a bound handle is validated against the live window list; if it no longer exists, the binding is marked stale and the user is told to run `/gs play` |
| Display resolution | At bind time, resolve which display contains the window's centre point and cache the display index (see §6.2.3) |

#### 6.1.3 Game identity and per-game naming

| Aspect | Requirement |
| --- | --- |
| Identity key | Lowercased executable basename, e.g. `eldenring.exe` |
| Collision handling | Two installs of the same exe must not share a session. Session slug = `<sanitised-exe>-<8-char hash of owner.path>` |
| Slug sanitisation | `[a-z0-9._-]`, truncated to 40 chars |
| Conversation | **Not this package's business.** No session is created, named or switched. |
| Collision case | Two installs of one exe in two conversations are simply two bindings. Nothing to reconcile. |

#### 6.1.4 Platform guard

On non-Windows, or when the native module fails to load, Gamer Sidekick **disables itself cleanly**: no commands registered that depend on capture, one `ctx.ui.notify` at load time, and a status line reading `[sidekick: unavailable on this platform]`. It must never throw during extension load.

#### 6.1.5 Foreground-window escape hatch — **WITHDRAWN (A1)**

Foreground targeting was specified here and has been removed. Re-resolving from the foreground window is wrong for this product: the player alt-tabs to pi to type, so the foreground window *is* the terminal. The mode could only ever be right under a picture-in-picture overlay this package does not have. The bound handle is now always re-validated per capture, which is the behaviour that actually holds up.

---

### 6.2 Capture Pipeline

#### 6.2.1 Stages

```
  bound HWND + cached bounds
        |
        v
  [1] RESOLVE   re-read window bounds from openWindows() by HWND;
        |        detect minimized / closed / covered
        v
  [2] DISPLAY   pick the display containing the window centre (cached
        |        from bind time; see 6.2.3)
        v
  [3] GRAB      screenshot-desktop -> full-display JPEG buffer
        |
        v
  [4] CROP      sharp .extract({left, top, width, height})
        |        using window bounds in display-local coordinates
        v
  [5] SCALE     .resize({ width: 1280, withoutEnlargement: true })
        |        (never upscale; a 720p game stays 720p)
        v
  [6] ENCODE    .jpeg({ quality: 80 })  ->  Buffer
        |
        v
  [7] ATTACH    ImageContent { type:"image", data: base64, mimeType:"image/jpeg" }
```

#### 6.2.2 Parameters

| Parameter | Value | Rationale |
| --- | --- | --- |
| Long edge | 1280 px, `withoutEnlargement` | Keeps image tokens bounded; above this the marginal read accuracy does not pay for the cost |
| JPEG quality | 80 | HUD text stays legible; dark scenes do not band badly |
| Format | JPEG | PNG at 1920x1080 is ~3 MB base64 vs ~250 KB |
| Window crop | Exact window bounds | Sends the game, not the desktop, the taskbar, or a chat app |

#### 6.2.3 Multi-monitor

`screenshot-desktop.listDisplays()` returns `{id, name}` **without bounds**, so it cannot by itself tell which display a window is on. Resolution:

1. At bind time, enumerate display bounds once (`[System.Windows.Forms.Screen]::AllScreens` through PowerShell, one invocation, result cached in memory and in the binding entry).
2. Store the matching `screen` index for `screenshot({screen})` alongside the window bounds.
3. If a window migrates to another display at runtime, the cached index is wrong. Detection: the cropped region falls outside the display's real bounds → re-resolve once, then continue. Cap re-resolutions at one per capture to avoid a loop.
4. Manual override: `/gs display <n>`.

#### 6.2.4 Failure handling

| Condition | Detection | Behaviour |
| --- | --- | --- |
| Window closed | HWND absent from `openWindows()` | Mark binding stale, notify once, send the question **without** an image, tell the model the frame was unavailable |
| Window minimized | `bounds.width === 0 \|\| bounds.height === 0` | Same as above; message names the reason |
| Capture returns black frame | Mean luminance of the crop below threshold | Retry once; if still black, warn (`capture returned a black frame — the game may be using exclusive fullscreen`) and attach nothing |
| Native module missing | `import()` throws at load | §6.1.4 clean disable |
| Crop fails (window partially off-screen) | `sharp.extract` throws | Clamp the rect to display bounds and retry once |

**Design rule:** a capture failure **never fails the user's question**. The prompt is always delivered; only the image is omitted, and the omission is stated explicitly to the model so it does not hallucinate having seen a frame.

---

### 6.3 Frame Attachment — the core mechanism

#### 6.3.0 Mechanism — **REVISED by A2**

§6.3.2 below argues for the request-local `context` hook. It was the right call
at the time and it is **no longer what ships**: the player asked for frames to be
ordinary conversation messages, which means they are persisted and survive a
`/resume`. Kept because the reasoning — and the cost it accepted — is the record
of that decision.

#### 6.3.1 When the frame is taken

`before_agent_start` — fired after the user submits a prompt, before the agent loop, carrying `event.prompt: string` and `event.images?: ImageContent[]`.

| Rule | Detail |
| --- | --- |
| Trigger | Every **user-submitted** prompt. Not on `steer` or `followUp` messages (a mid-turn steering message must not silently swap the frame — the user is looking at a *different* moment than the one they asked about) |
| Ordering | Capture is awaited before the handler returns, so the frame is in hand before the model request is built |
| Cost control | If the bound model does not accept image input, skip capture entirely and tell the user why (`/gs models` lists which are vision-capable) |

#### 6.3.2 How the frame reaches the model — and why it is *not* the obvious way

`BeforeAgentStartEventResult` accepts `message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">`, and `CustomMessage.content` accepts `ImageContent[]`. So attaching the image to the user message *is* possible. **It is also wrong**, because pi persists user messages into the session file — which would write ~330 KB of base64 per turn to disk, violating INV-2 and bloating every session file on the machine.

Instead, the frame is injected at the **`context`** event:

| Step | API | Persisted? |
| --- | --- | --- |
| 1. Capture | `before_agent_start` handler → `capture()` → store in an in-memory `pendingFrame` | No — nothing returned from the handler |
| 2. Record provenance | `pi.appendEntry("gamer_sidekick_frame", { id, exe, bounds, bytes, sha256Prefix, timestamp })` | **Yes — metadata only, no pixels** |
| 3. Inject | `context` handler → locate the final user message in `event.messages: AgentMessage[]` → return `{ messages }` with the frame spliced in immediately before it | **No — `context` is request-local; pi restores state afterwards** |
| 4. Tell the model | the injected message is `[TextContent(caption), ImageContent(...)]`, caption = `` `[FRAME #014 · eldenring.exe · 1920x1080 · captured 12:03:11 · this is the current game state]` `` | No |

**Why `context` and not `context_with_system`:** the `context` handler receives conversation messages *without* the system prompt and tool declarations, and pi restores that state afterwards. Gamer Sidekick has no business touching the system prompt, so `context` is the correct and least-invasive hook.

**Result:** full vision capability, zero image bytes on disk, and a transcript that reads `[FRAME #014 · eldenring.exe]` forever after.

#### 6.3.3 Frame budget

A vision model will happily accept fifty 1280px screenshots. The user cannot afford that and does not need it.

| Rule | Value | Rationale |
| --- | --- | --- |
| Live frames in context | **1** — the current turn's frame only | One frame is what the question is about |
| Pinned frames | **3** maximum, LRU-evicted with a visible notice | "Compare this to what I showed you earlier" |
| Frames before compaction is offered | 2 | Compaction (§6.9) summarises frames away with everything else |
| Frames in one turn | 1, unless the model calls `game_frame` (§6.6) | |

Approximate cost at `gpt-6-luna`: a 1280px image ≈ 1,100 input tokens ≈ **$0.00011** per frame. Immaterial; the budget is about context coherence, not money.

---

### 6.4 Frame Pinning — **WITHDRAWN (A2)**

Superseded. A frame in the conversation is already in context on every
following turn, which is the only thing a pin existed to do. `/gs pin`,
`/gs pins`, `/gs unpin` and `/gs compare` are gone; see §0 A2.

<details><summary>Original requirement (historical)</summary>

| Command | Behaviour |
| --- | --- |
| `/gs pin [id]` | Pin the current frame (or frame `id`) so it is re-injected at the head of the conversation on every subsequent turn |
| `/gs pins` | List pinned frames: id, exe, timestamp, byte size |
| `/gs unpin [id]` | Drop one pin; `/gs unpin all` drops all |
| `/gs compare` | Prompt template that instructs the model to compare the pinned frame(s) against the current one |

</details>

---

### 6.5 Per-Game Sessions

#### 6.5.1 The requirement

Each game executable gets its own conversation. Opening Elden Ring and asking a question must not put Elden Ring context into the Cyberpunk thread.

#### 6.5.2 Mechanism

All of this is pi functionality; Gamer Sidekick only calls it.

| Step | API |
| --- | --- |
| Persist the binding | `pi.appendEntry("gamer_sidekick_binding", {...})` into the current conversation |
| Restore on resume | read that entry back on `session_start` / first `before_agent_start` |
| Anything else | **none** — conversations are the player's (§0 A1) |

#### 6.5.3 Flow — **REPLACED BY A1**

`/gs play <exe>` binds the window, records the binding in the current conversation, and refreshes the status line. That is the entire flow. It never touches which conversation you are in.

#### 6.5.4 Commands — **WITHDRAWN (A1)**

`/gs game`, `/gs games` and `/gs autoswitch` are removed. The player uses pi's own `/resume`, `/rename` and `/new`.

---

### 6.6 Commands, Tools, and Status

#### 6.6.1 Slash commands (all via `pi.registerCommand`)

| Command | Purpose |
| --- | --- |
| `/gs play [exe\|n]` | Bind a game window (§6.1.2) |
| `/gs unbind` | Stop capturing; session becomes text-only |
| `/gs display <n>` | Override the display used for capture (§6.2.3) |
| `/gs shot` | Capture a frame now, attach it, and ask the model to describe it |
| `/gs pin [id]` / `/gs pins` / `/gs unpin [id]` | Frame pinning (§6.4) |
| `/gs frames` | Table of captured frames this session: id, exe, size, bytes, timestamp, pinned? |
| *(none)* | Session management is the player's, via pi's own `/resume` (§0 A1) |
| `/gs models` | List pi's models, marking which accept image input, cheapest first |
| `/gs status` | Bound window, display, model, thinking level, context usage, frames this session, estimated image tokens |
| `/gs setup` | Guided check: native module loads, window list readable, capture produces a non-black frame, selected model accepts images (§6.7.1) |
| `/gs help` | Command list |

Aliases: `/gamer` and `/sidekick` resolve to `/gs`.

#### 6.6.2 Model-callable tools (all via `pi.registerTool`)

| Tool | Parameters | Behaviour | Notes |
| --- | --- | --- | --- |
| `game_frame` | `{ reason?: string }` | Captures a new frame and returns metadata | Image is injected by the `context` handler (§6.3.2); the tool result is text + `details` only, so no pixels reach the transcript |
| `game_window` | `{}` | Returns bound window: exe, title, bounds, display, whether stale | Read-only |

Both are declared with `annotations: { readOnlyHint: true, openWorldHint: false }` so a permission extension never blocks them (`extensions.md`, tool exposure).

Both are registered `direct` — they are the point of the package and should be visible to the model on every turn. `game_window` is cheap; `game_frame` is **not** model-gated by default, so the tool description must state that each call attaches another image (§6.3.3).

#### 6.6.3 Status line

`ctx.ui.setStatus("gamer-sidekick", statusText)` renders in pi's footer. The line
is read without focusing on it, so it follows three rules: a **glyph carries
the state** (`●` bound, `○` unbound or starting, `×` broken) because it is the
one thing that must survive truncation; **weight sets the hierarchy**, since
pi's `sanitizeStatusText` collapses runs of spaces and a design leaning on
padding renders differently from the one that was written; and it **says nothing
that is not true**, so there is no frame counter until there is a frame to count.

```
○ Sidekick no window · /gs play
● Sidekick eldenring.exe · 1920×1440 · 14 frames
● Sidekick eldenring.exe · 1920×1440 · 14 frames · stale
```

Styling is emitted only in TUI mode, decided by `ctx.mode === "tui"` rather than
by `process.stdout.isTTY` — an extension shares pi's process, so the stdio check
gives the same answer in practice, but `ctx.mode` is a statement of intent
instead of an inference. `NO_COLOR` still wins. pi-tui is ANSI-aware
(`truncateToWidth` measures with `visibleWidth`), so escape codes cost no
visible width and cannot be truncated in half. Colour lives in
`extensions/style.ts`; chalk is pi's dependency and importing it from a package
that does not declare it would break when pi restructures its `node_modules`.

Updated on `before_agent_start`, `session_start`, `turn_end`, and every `/gs`
subcommand. Cleared on unbind.

> **Known limitation:** `setStatus` is documented as a **no-op in RPC mode**. Gamer Sidekick targets TUI mode (§6.8).

---

### 6.7 Model Configuration

#### 6.7.1 What Gamer Sidekick does *not* do

It does **not** manage API keys, define providers, price models, or maintain a model allowlist. Those are pi's job:

| Concern | Owner |
| --- | --- |
| API key storage | pi — `OPENAI_API_KEY` or pi's credential store |
| Provider config | pi — `models.json` / `custom-provider.md` |
| Model list | pi — `get_available_models()` |
| Switching model | pi — `/model`, `pi.setModel()` |
| Token counts and **cost** | pi — `Usage.cost` on every `AssistantMessage`; visible via pi's `/session` |
| Context usage | pi — footer |

Gamer Sidekick's only additions are the **frame-specific** numbers (§6.8) and a vision-capability check before capturing.

#### 6.7.2 System-prompt contribution

pi's system prompt is built from sections. Gamer Sidekick appends one section, only for sessions bound to a game:

```
[gamer-sidekick]
The user is asking about the game bound to this session (<exe>, <title>).
A screenshot of the current game state is attached to the most recent user message.
Describe only what is visible in the frame. If the frame is unavailable, say so plainly
instead of guessing. Be concise and actionable. Prefer concrete numbers, items, and
positioning over general advice. Do not claim you can see anything not in the frame.
```

Added via the `before_agent_start` `systemPromptOptions` mutation (not by replacing the whole prompt). Removing the extension removes the section.

---

### 6.8 Frame Accounting

Tracked in memory, displayed by `/gs status` and `/gs frames`:

| Metric | Source |
| --- | --- |
| Frames captured / attached / dropped | in-memory counters, reset per session |
| Bytes per frame | `Buffer.byteLength` before base64 |
| Estimated image tokens | `ceil(w/750) * ceil(h/750)` tiles × 85 tokens — the standard OpenAI vision tile estimate |
| Estimated image cost | image tokens × the active model's cached-input rate, from pi's `Usage` |

**No new pricing table is shipped.** pi owns pricing; Gamer Sidekick only multiplies.

---

### 6.9 Context and Compaction

Compaction is pi's. Gamer Sidekick's only additions:

| Requirement | Detail |
| --- | --- |
| Transparency | Compaction events (`compaction_start` / `compaction_end`) are surfaced in the status line so the user understands a pause |
| Frame handling | Because frames live in the `context` transformation, they are **not session entries** and therefore cannot be double-counted by compaction. Pinned frames are re-injected each request (§6.4) and are the only frames that survive indefinitely |
| Session-bound check | After compaction, the `gamer-sidekick` prompt section must still be present. If it is not, re-apply it on the next turn |

---

## 7. Package Layout and Manifest

```
pi-gamer-sidekick/
├── package.json
├── README.md
├── LICENSE
├── extensions/
│   ├── index.ts              # entry: registers everything
│   ├── state.ts              # the one mutable object every module shares
│   ├── binding.ts            # binding persistence + restore (§6.1)
│   ├── windowinfo.ts         # Win32/PowerShell shim: windows, displays, capture
│   ├── capture.ts            # pipeline + failure handling (§6.2)
│   ├── attach.ts             # before_agent_start → the conversation message (§6.3)
│   ├── ledger.ts             # metadata-only frame ledger, rebuilt on resume
│   ├── frames.ts             # the caption the model reads (§6.3.3)
│   ├── geometry.ts           # pure sizing/cropping/token maths (§6.2.2)
│   ├── identity.ts           # exe path → stable per-game slug (§6.1.3)
│   ├── commands.ts           # /gs command surface (§6.6.1)
│   ├── tools.ts              # game_frame, game_window (§6.6.2)
│   ├── prompt.ts             # system-prompt section (§6.7.2)
│   ├── style.ts              # ANSI styling for the footer, TUI-only (§6.6.3)
│   └── win/                  # C# P/Invoke compiled once to gs_win32.dll
├── types/
│   └── screenshot-desktop.d.ts
├── skills/
│   └── gaming-companion/
│       └── SKILL.md          # optional: deeper domain guidance the model
│                             # loads on demand (loot tables, meta builds)
└── prompts/
    └── gs-loadout.md         # /prompt template: "review my build"
```

Not shipped in the tarball (`package.json` `files`): `scratch/` (live probes
that need a running game), `test/`, `docs/`, and the compiled `gs_win32.dll` /
`gs_win32.stamp` — a shipped DLL with a fresh stamp would stop
`bootstrap.ps1` from ever recompiling it.

### `package.json`

```json
{
  "name": "pi-gamer-sidekick",
  "version": "0.1.0",
  "description": "A pi package that captures your game window and attaches the frame to your question.",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts/*.md"]
  },
  "dependencies": {
    "active-win": "^9.0.0",
    "screenshot-desktop": "^1.15.6",
    "sharp": "^0.33.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "typebox": "*"
  },
  "engines": { "node": ">=20" },
  "os": ["win32"]
}
```

**Rules honoured** (`packages.md`): host-provided packages are declared as `peerDependencies` with `"*"` and never bundled; runtime npm deps go in `dependencies` and are installed by pi; `pi-package` keyword makes it gallery-eligible.

---

## 8. Extension API Surface Used

Every API this package touches, with its verified signature. Nothing outside this list.

| API | Signature / shape | Used for |
| --- | --- | --- |
| `pi.on("before_agent_start", h)` | `(event: { prompt: string; images?: ImageContent[]; readonly systemPrompt: string; systemPromptOptions: NormalizedBuildSystemPromptOptions }, ctx) => Promise<BeforeAgentStartEventResult \| void>` | §6.3.1 capture trigger; §6.7.2 prompt section; tool gating |
| `pi.on("session_start", h)` | `(event, ctx) => Promise<void>` | binding restore, ledger rehydrate, status line |
| `pi.on("turn_end", h)` | `(event, ctx) => Promise<void>` | status line refresh |
| `ctx.ui` | `setStatus(key, text)`, `notify(message, level)`, `select(title, options, opts)`, `confirm(message, opts)` | §6.6.3 status line; the `/gs play` picker |
| `ctx.getSystemPrompt()` | `() => string` | §6.7.2 prompt section, idempotence check |
| `ctx.sessionManager.getEntries()` | `() => SessionEntry[]` (typed `ReadonlySessionManager`, which hides `appendCustomEntry` — see binding.ts) | binding restore, ledger rehydrate |
| `pi.registerCommand(name, opts)` | `opts: { description, getArgumentCompletions?(prefix), handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }` | §6.6.1 |
| `pi.registerTool(def)` | `def: { name, label, description, promptSnippet, promptGuidelines?, annotations, parameters: TSchema, execute(toolCallId, params, signal, onUpdate, ctx) => { content, details } }` | §6.6.2 |
| `pi.getActiveTools()` / `pi.setActiveTools(names)` | `(names?: string[]) => void` — read-modify-write so other extensions' tools survive | §6.6.2 tool gating |
| `pi.appendEntry(type, data)` | `(customType: string, data?: unknown) => void` | §6.3.2 frame metadata; §6.1.2 binding |

Removed after A1/A2: `pi.on("context", …)` (frame injection moved into
`before_agent_start`), `pi.on("session_info_changed", …)` and
`pi.on("compaction_start"/"compaction_end", …)` (never needed).
| `pi.setSessionName(name)` | `(name: string) => void` | §6.5.2 |
| `pi.getSessionName()` | `() => string \| undefined` | §6.5.3 |
| `pi.getSettings()` | `() => Settings` | reading user preferences |
| `ctx.switchSession(path, { withSession })` | `ExtensionCommandContext` | §6.5.2 |
| `ctx.newSession({ setup })` | `ExtensionCommandContext` | §6.5.2 |
| `ctx.ui.select(options)` | dialog; works in TUI **and** RPC mode | §6.1.2 picker |
| `ctx.ui.notify(msg)` | fire-and-forget | failure notices |
| `ctx.ui.setStatus(key, text)` | fire-and-forget; **no-op in RPC mode** | §6.6.3 |
| `ctx.mode`, `ctx.hasUI` | `"tui" \| "rpc" \| …`, boolean | mode guards |

**Deliberately not used:** `registerShortcut` (TUI keybinding only — cannot fire while a game has focus, §2), `registerProvider`, `registerMcpServer`, `registerVirtualModel`, `setHeader`/`setFooter` (no-ops in RPC mode), `withFileMutationQueue` (no file writes), `message_end` rewriting (would mutate the transcript).

---

## 9. Product Scope: Non-Competitive Games Only

Carried forward unchanged from the deprecated PRD — this is a product policy, not an architecture decision, and it survives the pivot.

Gamer Sidekick is for **single-player, offline, and PvE/co-op titles**. It is not for competitive online multiplayer.

Rationale: real-time advice during competitive play crosses from "assistant" into "cheating", is likely to violate terms of service, and puts the user's account at risk.

| Aspect | Requirement |
| --- | --- |
| Advisory list | Ship a small curated list of competitive titles by executable name |
| Action | `competitive_title_action: "warn" \| "block"`, default **`warn`** |
| `warn` | Bind normally, show a one-time notice on first bind |
| `block` | Refuse to bind, explain why, name the config key to change it |
| Configurable | The list and the action live in the binding entry and are user-editable; no code change required to harden or lift the policy |

---

## 10. Error Matrix

Status strings below are what pi draws in the footer, colour stripped.

| # | Condition | User sees | Model sees | Data at risk |
| --- | --- | --- | --- | --- |
| E1 | No window bound | `○ Sidekick no window · /gs play` | Normal text answer | none |
| E2 | Bound window closed | glyph turns yellow, `/gs status` says the window is gone — run `/gs play` | "The game window was not available, so I have no current frame." | none |
| E3 | Window minimized | glyph turns yellow, `/gs status` says minimized | same as E2, reason stated | none |
| E4 | Black frame | one notify: the capture failed; `/gs status` shows the reason (exclusive fullscreen is the usual cause) | "The frame capture failed; I cannot see the current state." | none |
| E5 | Capture support probe fails | `× Sidekick <reason>`; every `/gs` subcommand reports it | package inert | none |
| E6 | Non-Windows platform | `× Sidekick <reason>`; package inert | package inert | none |
| E7 | Selected model rejects images | capture still attached; the provider is the one that would fail | text-only answer | cost saved |
| E8 | ~~Pin limit reached~~ | **WITHDRAWN (A2)** — pinning is gone | — | — |
| E9 | Compaction in progress | nothing; pi owns the compaction indicator | nothing special | none |
| E10 | Capture exceeds the 3s budget | capture still attached; `/gs status` reports the timing | frame attached | none |

**Invariant INV-4:** every one of E1–E10 degrades to *a working text-only pi session*. The package never blocks a prompt.

---

## 11. Risks and Mitigations

| ID | Risk | Severity | Mitigation / fallback |
| --- | --- | --- | --- |
| **R-1** | **No overlay.** The user must alt-tab to a terminal to ask a question. This is a materially worse experience than a floating overlay and is the main thing users will notice is missing. | **High** | Accepted for v0.1.0. The whole point of shipping the package first is to learn whether the *conversation quality* justifies an overlay before building one. If it does, §11.1 describes the upgrade path |
| **R-2** | `screenshot-desktop` uses a GDI/DXGI screen copy. It may return **black frames under exclusive fullscreen** — the same class of failure the deprecated PRD analysed in §6.4 | Medium | E4 handles it honestly. Fallback ladder: (1) retry once, (2) instruct the user to use borderless fullscreen, (3) future: a WGC capture path |
| **R-3** | `active-win@9.0.0` is a native module last published 2024-04-30; prebuilt binaries may not cover Node 22 on some Windows builds | Medium | `/gs setup` verifies it at install time. Fallback: `child_process` + PowerShell `Get-Process`/`GetWindowRect` P/Invoke, which needs no native module |
| **R-4** | `sharp` is a large native dependency (~30 MB installed) | Low | Acceptable for prebuilt-binary installs. Fallback: send the full display uncropped and let the model cope (worse accuracy, higher token cost) |
| **R-5** | HWNDs are recycled by Windows; a persisted binding can point at an unrelated window | Medium | §6.1.2 — bindings are validated against the live window list on every `session_start` and before every capture, and never trusted blindly |
| **R-6** | Capturing on every prompt adds latency to the first token | Low | Budget 3s (§10 E10). Frames are pre-decoded and base64 strings are reused where the hash matches |
| **R-7** | `ctx.ui.setStatus` is a no-op in RPC mode, so the package looks broken under an RPC host | Low | Detect `ctx.mode !== "tui"` at load and fall back to `ctx.ui.notify` for important state only. Documented as TUI-first |
| **R-8** | Users expect an overlay, install this, and are disappointed | Medium | README leads with what it *is*. `/gs help` states it. The package name says "gamer", not "overlay" |

### 11.1 Upgrade path if the overlay turns out to matter

Recorded so the decision is not re-litigated later. **Not in scope now.**

Option B from the original discussion: keep this package as the entire brain, and add a thin **Tauri shell** that owns only the window, tray, and global hotkey, driving pi over RPC (`pi --mode rpc`). `prompt` already accepts `images: [{ type: "image", data, mimeType }]`, and token deltas already stream as `message_update` / `text_delta`. The capture, binding, session, and compaction logic in this PRD would be reused unchanged — it is all in the package.

---

## 12. Acceptance Criteria

### 12.1 Core loop

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| **AC-GS-01** | Bind with `/gs play`, then ask a question about the game | The question is answered with reference to the current frame; status shows `[FRAME #n · <exe>]` |
| **AC-GS-02** | Ask a question immediately after a visible screen change | The attached frame shows the state *after* the change, not before |
| **AC-GS-03** | Alt-tab to another app before pressing `Enter` | The captured frame is still the **bound game window**, not the alt-tab target |
| **AC-GS-04** | Answer a question that cannot be answered from the frame | The model says so, rather than inventing detail |

### 12.2 Sessions

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| **AC-GS-05** | Bind game A, ask three questions; switch to another conversation | The other conversation is unbound; nothing from game A leaks into it |
| **AC-GS-06** | Rebind game A after restarting pi | `/gs play` re-binds the window in the current conversation; no session is offered, named or switched |
| **AC-GS-07** | Drive one game session past the compaction threshold | Compaction runs, the transcript is unchanged, and the model still remembers earlier facts |
| **AC-GS-08** | ~~`/gs games` lists sessions~~ | **Withdrawn (A1)** — superseded by AC-GS-21 |

### 12.3 Privacy

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| **AC-GS-09** | Run a session with 20 captured frames; inspect every session JSONL file | **Zero** base64 image payloads on disk. Frame records contain metadata only |
| **AC-GS-10** | Search `%TEMP%`, `%APPDATA%`, and the package directory after a capture session | No new image files |
| **AC-GS-11** | Grep the installed package for filesystem writes | Only the config/binding writes in §6.1; no image buffer is ever passed to a write call |

### 12.4 Failure behaviour

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| **AC-GS-12** | Close the game window, then ask a question | Text answer, explicit "frame unavailable", stale-binding notice, no crash |
| **AC-GS-13** | Run in exclusive fullscreen | Either a correct frame, or E4's honest black-frame warning. Never a silent wrong answer |
| **AC-GS-14** | Uninstall the package and reinstall | No leftover state prevents a clean start; `/gs setup` re-runs |
| **AC-GS-15** | Load the package on macOS or Linux | Loads without throwing; capture reports unavailable |

### 12.5 Integration and hygiene

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| **AC-GS-16** | `pi install npm:pi-gamer-sidekick` | Installs with dependencies; no build step, no compiler, no `node-gyp` invocation on the user's machine (prebuilt binaries only) |
| **AC-GS-17** | Load the package in a pi session with no game bound | Zero captures occur; only the status hint appears |
| **AC-GS-18** | Two pi sessions running simultaneously, bound to different games | Each captures its own window; no cross-talk |
| **AC-GS-19** | Select a text-only model via `/model` | Capture is skipped (E7); the package does not waste a capture |
| **AC-GS-20** | `npm pack` the package and inspect the tarball | No `node_modules`, no bundled copy of a host-provided package, `pi-package` keyword present |
| **AC-GS-21** | `/gs play` in a conversation, then `/resume` a different one and ask a question | The resumed conversation captures only if it has its own binding entry; `/resume` back and capture resumes. `/gs` never creates, renames or switches a conversation. |

---

## 13. Milestones

| ID | Scope | Done when |
| --- | --- | --- |
| **M0** | Skeleton package: manifest, `/gs help`, `/gs status`, clean load everywhere | AC-GS-16, AC-GS-15, AC-GS-17 |
| **M1** | Binding: `/gs play` picker, identity/slug, stale-handle validation, display resolution | AC-GS-03, AC-GS-05 |
| **M2** | Capture pipeline + `before_agent_start` + `context` injection | AC-GS-01, AC-GS-02, **AC-GS-09**, AC-GS-10 |
| **M3** | Failure handling: closed, minimized, black, slow, crop-clamp | AC-GS-12, AC-GS-13 |
| **M4** | ~~Sessions: naming, switch, `/gs games`, autoswitch~~ → compaction transparency only | AC-GS-07, AC-GS-08, AC-GS-21 |
| **M5** | Polish: tools, pinning, status line, accounting, prompt section, README, `/gs setup` | AC-GS-04, AC-GS-11, AC-GS-14, AC-GS-18, AC-GS-19, AC-GS-20 |

M2 is the milestone that matters. **If frames cannot be attached without hitting disk, stop and re-scope** (see §6.3.2 — the `context` hook is the mechanism, and it is the design's load-bearing assumption).

---

## 14. Decisions

### 14.1 Resolved

| ID | Decision | Rationale |
| --- | --- | --- |
| **G-D1** | Ship as a pi package, not a standalone app | Pi already provides image attachment, streaming, sessions, compaction, model selection, and cost accounting. Rebuilding them is the exact cost the pivot avoids |
| **G-D2** | **No overlay window in v0.1.0** | Unreachable from inside a pi package: `registerShortcut` needs pi's terminal focused, and RPC mode makes `onTerminalInput()` a no-op. The window is possible only from an external host (§11.1) |
| **G-D3** | Capture target is a **bound window**, not the foreground window | The foreground window at capture time is the terminal the user is typing in. Foreground capture is structurally wrong for this product |
| ~~**G-D4**~~ **SUPERSEDED by A2** | Inject frames at the **`context`** event, not by rewriting the user message | `before_agent_start`'s message result is persisted to the session file; that would write ~330 KB of base64 per turn. The player wants the frame *in* the conversation, so the old rationale no longer applies. Frames are now returned as a custom message from `before_agent_start`, which costs disk and buys scrollback, `/resume` and persistence for free |
| **G-D5** | Frame budget: 1 live + 3 pinned | Bounded cost and context coherence; more than one frame per turn answers almost no real question |
| **G-D6** | No model list, pricing table, or API-key handling | pi owns all three. Duplicating them guarantees drift |
| **G-D7** | Non-competitive games only; advisory list, `warn` by default | Carried forward from the deprecated PRD; product policy, not architecture |
| **G-D8** | Capture failure never fails the question | A gaming companion that silently drops your question is worse than one that answers without a frame |
| **G-D9** | TUI mode is the primary target | `setStatus` and keyboard shortcuts are TUI-only. RPC is supported for status, but not a first-class target |
| **G-D10** | Rename to **Gamer Sidekick** | Distinguishes from the deprecated standalone product and from pi's own "Sidekick" reference in `active-win`'s browser list |

### 14.2 Open — owner decision needed

| ID | Question | Recommendation |
| --- | --- | --- |
| **G-O1** | Package name: `pi-gamer-sidekick` vs `@<owner>/pi-gamer-sidekick`? | Scoped name if publishing publicly; unscoped is fine for a private install |
| **G-O2** | Should `/gs play` be required, or should the first `/gs` invocation in a session prompt to bind? | Prompt once per session on the first captured turn, then stay silent |
| **G-O3** | Pin limit 3 vs 5? | 3 — pinned frames are re-injected every turn, and each costs ~1,100 tokens of permanent context |
| **G-O4** | ~~Auto-switch to another game's session when the bound game changes~~ | **Closed by A1** — no session switching at all |
| **G-O5** | Competitive-title list: ship one, or leave the hook empty? | Ship a short starter list; users can edit it without a code change |
| **G-O6** | Should `skills/gaming-companion` be included in v0.1.0, or deferred? | Defer to a post-v0 release — it is a content asset, not a mechanism, and it widens review surface |
| **G-O7** | License | MIT, if published |
| **G-O8** | Should the package also work under an RPC host (IDE-style client)? | Not in v0.1.0; note the `setStatus` limitation in the README instead |

---

## 15. Review Checklist

Before development starts, confirm:

- [ ] **G-D3 understood and accepted:** the capture target is a bound window, not the foreground window (§6.1.1). This is the difference between a working product and one that photographs a terminal.
- [ ] **G-D2 accepted:** no overlay in v0.1.0. The user alt-tabs to a terminal. (§4.2, §11 R-1)
- [x] ~~**G-D4 accepted: frames are injected at the `context` event so image bytes never reach disk. Enforced by AC-GS-09.~~ **SUPERSEDED by A2** — the player traded the disk guarantee for frames in the conversation.
- [ ] §6.3.2's `context`-injection mechanism is understood to be load-bearing. If it does not work, M2 stops and the package is re-scoped.
- [ ] Open decisions **G-O1 … G-O8** are answered.
- [ ] The competitive-title policy (§9) is accepted as a product constraint.
- [ ] The owner accepts that this package **cannot** become an overlay without the §11.1 upgrade (an external Tauri host driving pi over RPC).

**No development starts until this document is approved.**