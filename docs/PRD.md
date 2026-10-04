# Sidekick — Product Requirements Document

## Document Control

| Field | Value |
| --- | --- |
| Product | Sidekick |
| Version | **1.2.0 (Draft for review)** |
| Supersedes | 1.1.0 |
| Date | 2026-10-04 |
| Status | Draft — awaiting review. **No development starts until this is approved.** |
| Target platforms | Windows 10 1809+ / Windows 11 (x64 only, pilot) |
| Intended games | **Single-player, offline, and PvE/co-op titles. Not competitive or online multiplayer (§9).** |
| Stack | Rust 1.99 (stable), Tauri v2, WebView2 (TypeScript, React, Tailwind CSS) |
| AI provider | OpenAI — **Responses API** (`POST /v1/responses`) |
| Default model | **`gpt-6-luna`** (cheapest; $0.10 in / $0.50 out per 1M tokens) |
| Repository | `git` initialised on branch `main` at project root |
| Verification toolchain present | node v22.23.3, npm 12.2.0, cargo/rustc 1.99.0 |

---

## 1. What Changed From v1.0 / v1.1 (read this first)

### 1.1 Resolved by owner decision (v1.1 → v1.2)

| ID | v1.1 open question | Decision | Consequence in this document |
| --- | --- | --- | --- |
| C11 | **D2** — policy for competitive titles | **The app is built for non-competitive, offline, single-player/PvE games. Online competitive titles are out of scope.** | §9 rewritten as a hard product constraint; the integrity notice text changed; an advisory (non-blocking) competitive-title warning ships behind a config switch that can harden to a block later |
| C12 | **D3** — which OpenAI API surface | **Responses API** (`/v1/responses`), streaming | §6.6 rewritten with the concrete request shape, SSE event names, and `store: false`; reasoning control via `reasoning.effort` |
| C13 | **D4** — default model | **Cheapest models.** Default `gpt-6-luna`; picker sorts cheapest-first with per-model price tags | §6.7 rebuilt around a cost-sorted picker; compaction also runs on the cheapest model |
| C14 | **D9** — cost guardrails | **None. It is the user's own key and their spend.** Just surface usage and price in the overlay | §6.6.4 usage footer + `/usage` panel; no caps, no throttling, no monthly ceilings. `max_output_tokens` survives only as a *latency* bound, not a spending bound |
| C15 | **D10** — repository | **Git repo created** on branch `main` | Repo-local identity placeholder set (`Sidekick Dev <dev@sidekick.local>`) — **owner should replace it**; see §16 |

### 1.2 New capability (v1.1 → v1.2)

| ID | Requirement |
| --- | --- |
| C16 | **Per-game conversations.** Each game process gets its own isolated conversation, keyed by the game executable. Opening Elden Ring shows the Elden Ring conversation; opening Cyberpunk shows a different one. Context never bleeds across games. (§6.8) |
| C17 | **Resume where you left off.** Conversations persist across Sidekick restarts *and* game restarts. Reopening a game restores its full transcript and its model context. (§6.8.4) |
| C18 | **Context management & compaction.** When a conversation grows, older turns are compacted into a rolling *session digest* while recent turns stay verbatim, so continuity survives indefinitely without latency or context-window blowup. Pi-agent-style. (§6.9) |
| C19 | **REPL command surface.** Slash commands (`/help`, `/new`, `/compact`, `/summary`, `/pin`, `/sessions`, `/usage`, `/model`, `/export`, `/forget`) to drive sessions and context from the prompt line, pi-style. (§6.10) |
| C20 | **Transcript vs. context separation.** The player's scrollback is never destroyed by compaction; only the *model context* is compacted. Compaction is atomic, versioned, and crash-safe. (§6.9.2) |

### 1.3 Corrections carried forward from v1.0 (see v1.1 §1 for the original list)

| ID | v1.0 said | v1.1/v1.2 says | Why |
| --- | --- | --- | --- |
| C1 | Model allowlist `gpt-4o`, `gpt-4.5`, `gpt-5`, default `gpt-4o` | GPT-6 family (`gpt-6-luna` cheapest → `gpt-6.1-sol` → `gpt-6-astra` premium); default `gpt-6-luna` | v1.0's list was stale; **Luna is 100× cheaper than Astra** on both input and output |
| C2 | Filter on "OpenAI metadata" tags | Allowlist + denylist regex, two-tier | `/v1/models` returns only `id`/`created`/`object`/`owned_by` — **no capability metadata exists** |
| C3 | Capture crate undecided (`xcap` or `windows-capture`) | **Two engines:** WGC primary (windowed/borderless), DXGI Desktop Duplication fallback (exclusive fullscreen) | WGC returns black frames on exclusive fullscreen; DDA covers it but has its own edge cases |
| C4 | Overlay over game (implied always) | Explicit compatibility matrix — exclusive fullscreen is **capture-only** | Exclusive fullscreen bypasses the compositor; no always-on-top window can be drawn over it |
| C5 | Overlay must not appear in its own screenshot | Capture the game **HWND** (overlay excluded by construction); hide-and-restore only on the DXGI path | Display-level capture would capture the overlay |
| C6 | "Idle CPU 0.0%" | ≤ 0.1 % average over 60 s | 0.0 % is untestable at Task Manager's 1-decimal rounding |
| C7 | Credential Manager **or** encrypted store | `keyring` → Windows Credential Manager, DPAPI fallback | Stronghold requires the user to hold a separate password file |
| C8 | Not addressed | §9 anti-cheat & competitive-integrity policy | Largest unmitigated risk in v1.0; now a conscious product constraint |
| C9 | Not addressed | Error matrix (§7), IPC contract (§15.2), threading (§15.4), tests (§11), milestones (§13) | v1.0 described only the happy path |
| C10 | Retain last 3–5 exchanges | Superseded by **C16–C20**: continuous per-game context with compaction. `context_budget_tokens` (default 12,000) replaces the turn-count window | A fixed turn window either loses continuity or grows unbounded |

---

## 2. Executive Summary & Product Vision

**Sidekick** is a low-latency, low-footprint in-game companion overlay for PC gamers. Built on Rust + Tauri v2, it avoids Electron's memory profile and — critically — does not inject into, hook, or read the target process.

When summoned via a global hotkey, Sidekick presents a terminal/REPL-style chat surface over the running game. On every submitted prompt, Sidekick captures the current frame of the active game window, pairs it with the player's question, and streams the answer directly onto the game screen.

Sidekick behaves like a **persistent coding agent attached to a game**: each game has its own conversation, conversations survive restarts, and the model's context is compacted automatically so the companion never forgets what it told you twenty minutes ago — while staying fast and cheap enough to use mid-boss-fight.

**Design pillars**

1. **Zero interference.** No DLL injection, no hooks, no input automation, no memory reads. An ordinary always-on-top window — the same category of software as a voice chat app.
2. **Instant.** Hotkey → visible overlay < 100 ms. Enter → request dispatched < 80 ms.
3. **Continuous.** Per-game conversations that resume exactly where they left off, with automatic context compaction so memory is unbounded but latency is not.
4. **Private.** Frames exist only in RAM and only long enough to be transmitted. Conversations are text-only on disk, and every API request opts out of server-side retention (`store: false`).
5. **Honest.** Streaming from the first token, abortable at any time, with token counts and real price shown after every answer.

---

## 3. Goals, Non-Goals, Success Metrics

### 3.1 Goals (pilot)

| ID | Goal |
| --- | --- |
| G1 | A player goes from install to an AI-answered in-game question in under 3 minutes |
| G2 | The overlay is imperceptible: < 45 MB idle RAM, zero measurable FPS or input-latency impact |
| G3 | Frames are grounded correctly at ≤ 1.5 s to first token (p50, broadband) |
| G4 | Full support for windowed and borderless-fullscreen games across the test matrix (§11.4) |
| G5 | **Continuity:** every game has its own persistent conversation that resumes on relaunch, and survives unbounded length through compaction without losing pinned or recent context |

### 3.2 Non-goals for the pilot (explicitly out of scope)

- Cross-platform (macOS/Linux) — Windows only
- **Competitive / online multiplayer titles** (§9) — this is a product boundary, not a technical limitation
- Voice input/output, screen recording, video streaming
- Input automation, macros, aim assist, or any gameplay-affecting feature
- Cloud sync of conversations (local persistence only; no account, no server)
- Multiple AI providers (the provider seam exists, but only OpenAI ships)
- Game-specific integrations, game-state APIs, or telemetry scraping

### 3.3 Success metrics (pilot exit)

| Metric | Target |
| --- | --- |
| Setup completion (install → first successful answer) | ≥ 80 % of pilot testers |
| Capture success rate across the test matrix | ≥ 95 % of attempts |
| Median first-token latency | ≤ 1.5 s |
| Hotkey → overlay visible (p95) | ≤ 100 ms |
| Overlay-attributable FPS delta on test games | 0 |
| Crash-free sessions | ≥ 99 % |
| **Session resume correctness** (transcript + context restored exactly) | 100 % across the §11.3 matrix |
| **Compaction correctness** (no pinned/recent turn ever lost; transcript never truncated) | 100 % |
| **Compaction overhead** (added latency on the turn that triggers it) | ≤ 1.5 s |
| Distinct testers using it ≥ 3× in a week | ≥ 50 % — the honest test of usefulness |

---

## 4. Personas & Scenarios

| Persona | Need | Representative prompt |
| --- | --- | --- |
| **Boss-rush player** | "What am I missing in this fight?" | `what's hitting me from off screen` |
| **Build optimizer** | "Is this better than what I built?" | `read my stats panel, is this rotation right` |
| **Explorer** | "Where did I just go?" | `where do i go from here` |
| **Learner** | "Explain this mechanic without pausing" | `explain the parry timing window shown here` |
| **Returning player** | "Remind me what we decided 40 minutes ago" | `what did we figure out about this boss` |

The last persona is what the session system (§6.8–6.9) exists for: continuity across a play session, without ever alt-tabbing or pausing.

---

## 5. User Flow & State Model

```
Launch sidekick.exe
  │
  ├─ single-instance check ──(already running)──▶ focus existing instance, exit
  │
  ├─ config present & valid? ──no──▶ Config Wizard (§6.1) ──Save──┐
  └─yes──────────────────────────────────────────────────────────┤
                                                                 ▼
                                        ┌───────────────────────────────────────┐
                                        │ TRAY RESIDENT (no window)             │
                                        │  Toggle Overlay / Settings /          │
                                        │  Reset Session / About / Quit         │
                                        └───────────────────────────────────────┘
                                          │ global hotkey
                                          ▼
                            probe foreground window ──► resolve game key (e.g. eldenring.exe)
                                          │                    │
                            no game / own window                 ▼
                            → tray notification        ┌──────────────────────────────┐
                                                     │ LOAD OR CREATE SESSION        │
                                                     │  transcript + digest + budget │
                                                     └──────────────────────────────┘
                                                                  │ overlay shown
                                                                  ▼
                                        ┌────────────────────────────────────────────┐
                                        │ OVERLAY  [SIDEKICK // eldenring.exe //    │
                                        │            24 turns // resumed]           │
                                        │  transcript (full history, scrollback)    │
                                        │  λ prompt bar                            │
                                        └────────────────────────────────────────────┘
                     Enter │                                    │ Esc / hotkey / tray-toggle
                          ▼                                     ▼
             ┌────────────────────────────┐          ┌──────────────────────┐
             │ BUSY                       │          │ hide + return focus  │
             │ capture → stream           │─────────▶│ to game; abort stream│
             │ on threshold: compact      │          └──────────────────────┘
             └────────────────────────────┘
```

**Invariants**

- Rust is the single source of truth for sessions, config, and streaming state. The webview renders it and never owns it.
- **One session per game process.** The active session is a function of the foreground process; switching games switches the whole conversation.
- **Transcript ≠ context.** The transcript is the complete, persisted, scrollable history. The context is the compacted subset sent to the model. Compaction never deletes the transcript (§6.9.2).
- Exactly one in-flight request at a time. A second `Enter` while busy is ignored (the keystroke stays in the buffer).
- Hiding the overlay aborts any in-flight stream and marks the partial answer `⏹ cancelled`.
- The game keeps rendering at full speed in every state; Sidekick never blocks the game process.
- Every session write is atomic. A crash mid-write leaves either the old valid file or the new valid file, never a corrupt one.

---

## 6. Functional Specification

### 6.1 First-Run Onboarding & Configuration

On boot, Rust resolves `%APPDATA%\sidekick\` and checks `config.json`. If absent, unparsable, or failing validation, the **Config Wizard** opens as the primary window; the tray icon is **not** created until setup completes (AC-01).

| Property | Control | Validation | Default |
| --- | --- | --- | --- |
| Window opacity | Slider 20–100 % | CSS canvas opacity + OS acrylic/mica backdrop | 85 % |
| Window size W / H | Sliders 380–650 px / 450–800 px | Clamped; re-validated on DPI change | 480 × 620 px |
| Overlay anchor | Select: top-left / top-right / bottom-left / bottom-right / center | — | top-right |
| AI provider | Select, disabled (`OpenAI — pilot`) | Locked | OpenAI |
| API key | Masked input + **Test connection** | Live `GET https://api.openai.com/v1/models`; 401 → inline error, model select stays disabled | empty |
| Model | Searchable, cost-sorted select (§6.7) | Populated after key validates | `gpt-6-luna` |
| Image detail | Select `auto` / `low` / `high` | `low` recommended at ≥ 1080p | `auto` |
| **Context budget** | Slider 2,000–200,000 tokens | Soft compaction threshold (§6.9.3) | **12,000** |
| **Compaction model** | Select, cheapest-first | Must differ from nothing; may equal the chat model | cheapest available |
| **Keep recent images** | Number 0–3 | How many past turns keep their frame attached | 1 |
| Prompt history depth | Number 10–100 | ↑/↓ recall length, per session | 20 |
| Global hotkey | Key recorder | `RegisterHotKey` must succeed; conflict → inline "in use by another app" | `Alt+Space` |
| Start on login | Toggle | Optional | off |
| Competitive-title action | Select `warn` / `block` | Per §9 | `warn` |
| Encrypt transcripts at rest | Toggle | DPAPI; see §8 | off |
| **Integrity notice** | Required checkbox | §9 text, rewritten for the offline/PvE scope | — |

**Wizard behavior**

- Per-field validation on change; **Save** disabled until all required fields pass.
- **Save** order: write API key to Credential Manager → write `config.json` → register hotkey → create tray → hide wizard. If hotkey registration fails, the wizard stays open with that field highlighted; the config is still saved so only the key must be re-picked.
- Reopening **Settings** shows current values with the key rendered as `sk-…••••` and a **Replace / Keep** choice. The raw key is never sent to the webview.
- A **Reset all data** action (clears config, credentials, and every stored session) lives in Settings behind a typed confirmation.

### 6.2 System Tray & Process Lifecycle

| Item | Spec |
| --- | --- |
| Tray creation | After successful setup only (AC-01); tooltip reflects state: `Sidekick — idle` / `— eldenring.exe` / `— thinking` |
| Menu 1 | **Toggle Sidekick Overlay** — disabled with a reason when no eligible game window is focused |
| Menu 2 | **Settings** |
| Menu 3 | **Reset Session** — clears the *current game's* conversation (§6.8.5) |
| Menu 4 | **Sessions…** — lists stored game conversations, shows turn count + last active, allows switch/rename/delete/export |
| Menu 5 | **About** — version, GPU, idle RSS, log folder, copy-diagnostics |
| Menu 6 | **Quit Sidekick** |
| Single instance | `tauri-plugin-single-instance`; a second launch focuses the running instance |
| Idle footprint | ≤ 45 MB RSS; ≤ 0.1 % average CPU over 60 s; no capture timers, no network sockets, no polling while idle |
| Suspend/resume | On `WM_POWERBROADCAST` suspend → abort in-flight work, drop cached DDA handles and session caches; on resume → re-acquire lazily on next capture |
| Crash recovery | Next launch detects a dirty-shutdown marker and offers "restore last session / start clean" |

### 6.3 Hotkeys & Keys

| Binding | Scope | Behavior |
| --- | --- | --- |
| Global hotkey (default `Alt+Space`) | Global | Toggle overlay |
| `Escape` | Overlay | Abort if streaming; else hide overlay + return focus to the game |
| `Ctrl+L` | Overlay | Clear the **visible transcript** only (context and disk history are untouched) |
| `Ctrl+Shift+L` | Overlay | Reset the **current game's session** entirely (§6.8.5) |
| `Ctrl+P` | Overlay | Toggle click-through `[PEEK]` mode (§6.5) |
| `Ctrl+U` | Overlay | Show the usage panel (§6.6.4) |
| `↑` / `↓` | Overlay | Prompt history (per session, persisted) |
| `Enter` | Overlay | Submit prompt |
| `Shift+Enter` | Overlay | Newline |

**Conflicts to handle:** `Alt+Space` is claimed by some IME/language tooling and legacy apps. Registration failure is a first-class inline state, not an error dialog. Warn when the combination contains `Space`, `Alt`, or a bare `F1`–`F12`.

**Focus-return caveat:** `SetForegroundWindow` is subject to foreground-lock rules. The implementation uses the `AttachThreadInput` + `SetForegroundWindow` pattern. This is a known-flaky Win32 area and gets dedicated manual coverage (§11.3).

### 6.4 Game Detection & Native Capture

**6.4.1 Foreground probe** (`GetForegroundWindow` → `GetWindowThreadProcessId` → `QueryFullProcessImageNameW`)

- Resolve the owning process name (`eldenring.exe`), full image path, and window title.
- Reject: Sidekick's own windows, shell/desktop processes, any window with a zero client area, and any process on the advisory competitive list when `competitive_title_action = block`.
- Cache the probe for 2 s — the hotkey path must not pay full probe cost on every press.

**6.4.2 Two capture engines**

| Engine | Crate/API | Selected when | Why |
| --- | --- | --- | --- |
| **WGC (primary)** | `windows-capture` 2.x | Windowed or borderless fullscreen | Captures the game **HWND** directly → overlay excluded by construction, no flicker, fastest |
| **DXGI Desktop Duplication (fallback)** | `windows` crate DDA (`DuplicateOutput` / `AcquireNextFrame` / `MapOutputStream`) | Exclusive fullscreen, or WGC yields black/empty | Covers exclusive fullscreen, which WGC cannot. Display-level, so the overlay must be hidden for the capture and restored immediately after |

DDA handles (device + output + duplication object) are **created once and cached** — per-capture creation costs tens of ms and would break the latency budget.

**6.4.3 Pipeline & budget**

```
Enter pressed
  → probe foreground window (cached, ≤ 5 ms)
  → select engine (WGC preferred)
  → acquire frame                       ┐
  → crop to client area (drop chrome)   │
  → downscale if > 1920×1080           ├─ total < 40 ms
  → encode JPEG q85                     │
  → base64 data URI                     ┘
  → build Responses payload, dispatch   (< 80 ms from Enter)
```

- Encoding runs on the capture worker (`spawn_blocking`); the webview never blocks.
- One `FrameBuffer` value, owned explicitly, dropped as soon as the HTTP body is built. No clones, no disk, no cache, no clipboard.
- **Black-frame detection:** sample mean luminance; if ≥ 98 % near-black and the scene is not genuinely black, retry once with the other engine, then surface an explicit error (§7.3).
- The capture worker is **serialized** (queue depth 1): a rapid double-`Enter` must not spawn two captures.

**6.4.4 Compatibility matrix**

| Game mode | Overlay visible | Engine | Result |
| --- | --- | --- | --- |
| Windowed | Yes | WGC | Full support |
| Borderless fullscreen | Yes | WGC | Full support (primary target) |
| Exclusive fullscreen | **No** (compositor bypassed) | DXGI | Degraded: capture + answer, overlay shown once the game returns to a composited mode; the UI says so explicitly rather than appearing broken |
| Minimised / other desktop / UAC prompt | No | — | Hotkey is a no-op + tray notification |
| HDR display | Yes | Either | Capture may be tone-mapped darker; acceptable, documented |

### 6.5 Pi-Style REPL Overlay

**Aesthetic** — monospace (`JetBrains Mono`, fallback `Cascadia Mono`/`Consolas`), deep charcoal translucent canvas, emerald accent + amber warnings, muted gray secondary text, subtle scanline/blur layers. Opacity from config; must stay legible at 85 % over both bright and dark game content. `prefers-reduced-transparency` and the Windows "transparency effects" accessibility setting force 100 % opaque.

**Layout**

- Frameless draggable header:
  `▌ SIDEKICK // eldenring.exe // 24 turns // gpt-6-luna // resumed // [INTERACTIVE]`
  with a status dot: `IDLE` / `CAPTURE` / `STREAM` / `COMPACT` / `ERROR`.
- Scrollback transcript, auto-scrolled, pinned to the bottom unless the player scrolled up (then a "jump to latest" affordance appears).
- Bottom prompt bar with a fixed `λ ` indicator and blinking caret.

**Message rendering**

| Element | Behavior |
| --- | --- |
| User message | `λ <text>` in accent colour, timestamped `HH:MM:SS` |
| Frame badge | Inline `[FRAME #014 · 1920×1080 · JPEG 84 KB · wgc]`. Clicking expands a thumbnail **for the current overlay session only** (memory-backed object URL, revoked on hide/reset). Nothing is written to disk. |
| Assistant message | Markdown streamed token-by-token: headings, lists, tables, inline code, fenced blocks with a copy button |
| Reasoning tokens | **Never rendered.** Counted for cost, discarded |
| Compaction notice | `[context compacted · 24 → 6 turns · digest v3 · −18 turns]` — an honest, dismissible status line |
| Usage footer | `1.2 s · 1.1k in / 340 out · est $0.00042` (§6.6.4) |
| Errors | Inline `!!` block with the exact message, `AppError.code`, and a **Retry** action that re-sends with a fresh capture |
| Pinned turns | Marked `📌 PINNED` in the transcript; exempt from compaction (§6.9.4) |

**Overlay window behaviour**

- `alwaysOnTop: true`, `decorations: false`, `transparent: true`, `skipTaskbar: true`.
- **Click-through** is a **whole-window mode**, not per-pixel: `INTERACTIVE` (input captured) ⇄ `PEEK` (`Window::set_ignore_cursor_events(true)` — clicks pass to the game while the overlay stays visible). Pixel-accurate click-through is not available in Tauri v2 (open upstream feature request). Mode is shown in the header and toggled with `Ctrl+P`.
- Positioned per the configured anchor with a 24 px margin; re-anchored when the game window moves or the display/DPI changes.
- Shown with `show()` + `set_focus()`; hidden with `hide()`.

### 6.6 OpenAI Pipeline (Responses API)

**6.6.1 Request shape**

```
POST https://api.openai.com/v1/responses
{
  "model": "gpt-6-luna",
  "store": false,                                  // opt out of server-side retention
  "stream": true,
  "reasoning": { "effort": "none" },                // omitted if the model does not support it
  "max_output_tokens": 700,
  "input": [
    { "role": "system", "content": [ { "type": "input_text", "text": "<system prompt>" } ] },
    { "role": "user",   "content": [ { "type": "input_text",  "text": "<session digest>" },
                                     { "type": "input_text",  "text": "<player query>" },
                                     { "type": "input_image", "image_url": "data:image/jpeg;base64,…",
                                       "detail": "auto|low|high" } ] }
  ]
}
```

- `store: false` is **mandatory**: the Responses API otherwise retains responses server-side (≈30 days). Sidekick opts out on every request, including compaction calls. New AC-29.
- **Explicit history, not `previous_response_id`.** Sidekick sends the full composed `input` array every turn because compaction drops images and prunes turns deterministically, and because `store: false` removes server-side chaining. Decision recorded in §14.
- `reasoning.effort` is **capability-gated per model** — `gpt-6-luna` supports `none | low | medium | high | xhigh | max`; `gpt-6-astra` supports `low | medium | high | xhigh | max` (no `none`). Never hardcode: read the capability map (§6.7.3) and omit the field when unsupported. Pilot default is `none` on Luna — a player mid-boss cannot afford reasoning latency.
- `max_output_tokens` is a **latency/verbosity bound, not a spending bound** (§C14). Default 700, configurable 200–4,000.

**System prompt (fixed)**

> You are Sidekick, an elite real-time gaming strategist. Analyze the provided game screenshot and the player's query. Provide clear, concise, actionable advice. Avoid fluff. Keep answers under 150 words unless the player asks for detail. If the screenshot does not contain enough information to answer, say exactly what is missing — never guess at what you cannot see.

**6.6.2 Streaming**

- Rust `reqwest` SSE reader on a Tokio task, one task per `request_id`, emitting `sidekick://stream-token` per delta.
- Consumed events: `response.output_text.delta` → token; `response.completed` → `sidekick://stream-done` with usage; `response.failed` / `error` → `sidekick://stream-error`. Unknown event types are ignored (forward compatibility).
- **Reasoning summaries are never requested.** Reasoning tokens are counted for cost, never displayed.
- The webview re-parses only the streaming tail (`MarkdownStream`); a 2,000-token answer must not degrade the overlay's frame rate.
- Cancellation aborts the HTTP request immediately and marks the partial answer `⏹ cancelled` — partial output is never silently dropped.

**6.6.3 Composed input assembly**

Order is fixed so that the stable prefix (system prompt + digest) stays byte-identical turn to turn, which is what makes provider-side prompt caching possible later:

```
[system prompt]  ← static
[session digest] ← changes only on compaction
[recent window]  ← verbatim turns
  ├─ pinned turns (any age)
  ├─ recent turns, with images for the last `keep_recent_images`
  └─ older turns: text only, or dropped into the digest
[current query + frame]
```

**6.6.4 Usage & price in the overlay** (owner decision C14 — *display only, no guardrails*)

There are **no spending caps, no monthly ceilings, and no cost-based throttling**. Sidekick uses the player's own key and the player pays their own bill. Sidekick's job is to make the spend legible:

- **Per-answer footer:** `1.2 s · 1.1k in / 340 out · est $0.00042` (input/output/reasoning tokens from `response.usage`).
- **`Ctrl+U` / `/usage` panel:** current session totals, per-game totals, lifetime totals, current model, and the pricing in effect.
- **Settings → Usage:** lifetime totals and per-session breakdown, exportable as CSV.
- **Cost formula:** `(input_tokens − cached_tokens) × in_price + cached_tokens × cached_in_price + output_tokens × out_price`, all per-1M-token rates from the pricing table (§6.7.4). Reported when known; shown as `—` when the model's price is unknown, never guessed.
- `input_tokens_details.cached_tokens` is surfaced as a `cached` hint. Prompt-cache utilisation is a **non-pilot optimisation**, noted because cached input is billed at 10 % of the uncached rate.

### 6.7 Model Discovery, Filtering & Pricing

**6.7.1 Filter (two tiers)**

`GET /v1/models` returns only `{ id, created, object, owned_by }` — **no capability metadata** — so filtering must be heuristic.

*Tier 1 — allowlist:* `gpt-6*`, `gpt-5*`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`

*Tier 2 — denylist (applied after the allowlist):*
```
*-embedding-*  text-embedding-*  text-embedding-3-*  tts-*  whisper-*
gpt-4o-audio-*  gpt-4o-realtime-*  gpt-4o-mini-tts  *-realtime  *-live
dall-e-*  gpt-image-*  gpt-*-transcribe  omni-moderation-*
*-codex  gpt-*-search  *deep-research  computer-use-preview
o1*  o3*  o4*
```

Rules: allowlist first, denylist second; a model must be allowlisted **and** not denylisted. An empty intersection shows an explicit warning with the raw count plus **Show all models**. The list is cached 10 min, refreshed on wizard open or manual refresh, and a fetch failure never blocks configuration.

**6.7.2 Cost-first presentation** (owner decision C13)

The picker is sorted by **blended price ascending** and grouped:

| Group | Models (verified 2026-10-04) | Input / 1M | Output / 1M |
| --- | --- | --- | --- |
| **Cheapest** | `gpt-6-luna` *(default; tagged "Default" by OpenAI)* | **$0.10** | **$0.50** |
| Balanced | `gpt-6.1-sol` | *verify in M4* | *verify in M4* |
| Premium | `gpt-6-astra` | $10.00 | $50.00 |

Each row shows `$x.xx · $y.yy  in·out` so price is visible at selection time. Default selection is the cheapest available allowlisted model, falling back through the sorted list. `gpt-6-luna` is also the default **compaction** model — summarisation does not need a premium model.

**6.7.3 Capability map**

A static, unit-tested map of per-model-family capabilities: vision in, streaming, `reasoning.effort` values accepted, context window, max output. Default context window used for budgeting: **1,050,000 tokens** (Luna and Astra). Unknown models fall back to conservative defaults and omit optional fields rather than sending unsupported ones.

**6.7.4 Pricing table & rate modifiers**

Built-in table, **verified against `developers.openai.com/api/docs/pricing` on 2026-10-04**:

| Model | Input | Cached input | Cache writes | Output |
| --- | --- | --- | --- | --- |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 |
| `gpt-6-astra` | $10.00 | $1.00 | $12.50 | $50.00 |
| `gpt-6.1-sol` | *unverified — must be filled during M4* | | | |

Rate modifiers documented so cost arithmetic is explainable: cached input bills at 10 % of the uncached input rate; cache writes bill at 1.25×; prompts over 272 K input tokens bill at 2× input / 1.5× output; Batch and Flex bill at 50 %; Fast mode at 2×; regional processing adds 10 %. **Sidekick uses none of Batch/Flex/Fast in the pilot** (all add latency that defeats the product).

The table ships in `config.json` as `pricing` and is user-overridable in Settings, so a price change never requires a release. Unknown models display tokens with `—` cost.

**6.7.5 Escape hatch** — the filter exists to stop players picking a text-only or embedding model, not to lock them out. `Show all models` plus manual model-ID entry is always available; a stale filter can never hard-block a paying user.

### 6.8 Per-Game Sessions & Resume

**6.8.1 Session identity**

A session is keyed by the game process:

```
key   = lowercase process name            e.g. "eldenring.exe"
slug  = sanitised key + short exe-path hash e.g. "eldenring.exe-a1b2c3"
```

The path hash disambiguates two different executables that share a filename (common for generic names like `game.exe`). The pair `(key, exe_path_hash)` is the identity; the slug is only the filename.

**6.8.2 Isolation rules**

- At most one session is *active* at a time; the active session is derived from the foreground process on every hotkey press.
- Switching games swaps the entire conversation and the entire model context. Context never mixes.
- No cross-game retrieval, search, or shared digest. Ever.
- Opening a game with no prior session creates one lazily on the first submitted prompt (never on hotkey press, so browsing games costs nothing).

**6.8.3 On-disk format**

```
%APPDATA%\sidekick\sessions\<slug>.json
```

```jsonc
{
  "schema_version": 1,
  "key": "eldenring.exe",
  "exe_path_hash": "a1b2c3",
  "title": "Margit — second attempt",
  "created_at": "2026-10-04T19:02:11Z",
  "updated_at": "2026-10-04T20:41:55Z",
  "model": "gpt-6-luna",
  "digest": { "text": "Player is fighting Margit…", "version": 3, "updated_at": "…", "source_turn_count": 24 },
  "turns": [
    { "id": "t_0001", "role": "user",      "ts": "…", "text": "what's hitting me",
      "frame": { "width": 1920, "height": 1080, "bytes": 84012, "engine": "wgc", "detail": "low" },
      "pinned": false, "compacted_out": false },
    { "id": "t_0002", "role": "assistant", "ts": "…", "text": "…", "frame": null,
      "pinned": true, "compacted_out": false }
  ],
  "counters": { "requests": 12, "input_tokens": 44120, "output_tokens": 3890,
                "reasoning_tokens": 0, "cached_tokens": 0, "est_cost_usd": 0.0063 },
  "prompt_history": ["what's hitting me", "…"]
}
```

**`frame` stores metadata only — never image bytes.** No session file contains a screenshot, in any form.

Writes are atomic (temp file + rename) with an fsync before rename. A `sessions/index.json` maps slug → `{key, exe_path_hash, title, turn_count, updated_at}` for the Sessions list without opening every file.

**6.8.4 Resume behaviour**

On hotkey press → probe → resolve key → look up slug → if a session file exists: load it, hydrate the transcript, restore the digest and counters, and mark the header `resumed`. If not: create in memory, mark `new`. Session load is capped (§10) and runs off the UI thread; a slow or corrupt file degrades to a fresh session with a toast (§7.11) rather than blocking the overlay.

Resume survives: Sidekick restart, game restart, machine reboot, and overlay hide/show. It is **not** tied to the overlay being open — the conversation lives at the session layer.

**6.8.5 Session lifecycle commands**

| Action | Effect |
| --- | --- |
| Reset Session (tray) | Deletes the **current game's** conversation (file removed, counters gone) after confirmation |
| `Ctrl+Shift+L` | Same as Reset Session, for the focused game |
| `/new` | Archives the current conversation to `sessions/archive/<slug>-<timestamp>.json`, then starts a fresh one |
| `/forget` | Deletes this game's conversation from disk without archiving |
| `/export` | Copies the transcript to the clipboard, or saves it as `.md` — the only path by which data leaves the app, and only on explicit user action |
| Retention | Keep the **50** most recently updated sessions; prune older files on startup and on each save |
| Per-file cap | 1 MB of text; the oldest non-pinned turns are dropped past that, with a visible notice (a 1 MB transcript is roughly 8,000 turns — this is a safety valve, not a real limit) |

### 6.9 Context Management & Compaction

This is the mechanism that lets a conversation run for hours without the model forgetting, without latency growing, and without the context window ever being the limiting factor.

**6.9.1 The three layers**

| Layer | Content | Lifetime |
| --- | --- | --- |
| **1. System prompt** | The fixed Sidekick identity prompt (~80 tokens) | Static |
| **2. Session digest** | A rolling plain-text summary, **≤ 250 words**, of everything compacted so far. Replaced in place on each compaction (`digest.version` increments) | Until the next compaction |
| **3. Recent window** | The last `N` exchanges **verbatim**, with frames attached to the most recent `keep_recent_images` turns | Rolling |
| **⊕ Pinned turns** | Any turn the player pinned — verbatim, exempt from compaction regardless of age | Until `/unpin` |

**6.9.2 Transcript ≠ context (the safety rule)**

- The **transcript** is the complete history. It is what the player scrolls. **Compaction never deletes, truncates, or edits a single turn of the transcript.**
- The **context** is what gets sent to the API. Compaction only changes this.
- Therefore compaction is always safe to perform, retry, or abandon: a bad digest degrades a future answer, it cannot destroy history.

**6.9.3 Trigger & budget**

| Parameter | Default | Notes |
| --- | --- | --- |
| `context_budget_tokens` | **12,000** | Soft threshold for the *next* request, estimated locally with `tiktoken-rs` and calibrated against the API's reported `input_tokens` |
| `recent_window_exchanges` | 6 | Verbatim turns kept regardless of budget |
| Hard ceiling | Model context window (1,050,000) | Never approached in practice; exists only as a backstop |
| Trigger | `estimated_next_request_tokens > context_budget_tokens` | Checked **before** dispatch, on the request that would cross the line |
| Overrun backstop | API context-length error → compact → retry once | AC-32 |

**Why 12,000 and not 1,050,000?** Deliberate. The model's window is enormous, but a 12 K-token prompt is answered faster, costs almost nothing at Luna rates (12 K input ≈ $0.0012), and keeps the *relevant* material near the top where the model attends to it best. Compaction is a **coherence and latency tool**, not a capacity necessity.

**6.9.4 Compaction procedure** (atomic, versioned, crash-safe)

1. Snapshot the turns eligible for compaction: everything older than the recent window, **minus pinned turns**.
2. If the eligible set is empty, do nothing (budget pressure is being caused by pinned turns — tell the player).
3. One non-streaming call to the **compaction model** (default: cheapest available), with `reasoning.effort: none`, `max_output_tokens: 400`, `store: false`:
   > Summarize this game-assistant conversation for your own future reference. Preserve: the player's current goal and progress; build/gear/stats facts you read from screenshots; decisions already made **and** options rejected, with the reason; unresolved questions and open threads; the player's stated preferences (verbosity, language, controls). Drop pleasantries. Plain text, ≤ 250 words.
4. Input to that call = **`<existing digest>` + `<eligible transcript>`**, so each digest summarises the digest plus the new material in a **single pass** — no recursive re-summarisation, no drift.
5. Persist the new digest with `version + 1`, `updated_at`, and `source_turn_count` atomically; mark affected turns `compacted_out: true` (a flag only — their text stays).
6. Emit `sidekick://context-compacted`; the overlay shows `[context compacted · 24 → 6 turns · digest v3 · −18 turns]`.
7. On any failure: keep the previous digest version, retry once, and surface a non-blocking notice. **Never** touch the transcript, and never block the answer the player asked for — if compaction fails, the turn proceeds with the previous context and a warning.

**6.9.5 Frame policy in context**

- Frames are attached to the **current query only**, plus the last `keep_recent_images` (default **1**) previous turn — so "compare this to what my screen looked like a minute ago" works.
- All older frames are dropped from the context and replaced by the literal stub `[frame omitted — summarised in context]` inside the eligible set. Frame *metadata* stays in the transcript forever.
- The digest prompt is explicitly told that frames are absent, so it never claims to have seen an image it did not see.

**6.9.6 Player control**

- `/compact` — force compaction now, print the resulting digest.
- `/summary` — print the current digest, turn counts, token estimate, and budget headroom.
- `/pin` / `/unpin` — pin the most recent assistant answer (or the last turn) so compaction can never drop it. Also available from a right-click menu on any transcript entry.
- The status bar always shows `turns` and a context meter (`ctx 4.2k / 12k`), so the player is never surprised by compaction.

### 6.10 REPL Command Surface

Typed at the `λ` prompt; parsed before capture so a command never takes a screenshot or spends a token.

| Command | Effect |
| --- | --- |
| `/help` | List commands with one-line descriptions |
| `/new` | Archive this game's conversation and start a fresh one |
| `/clear` | Clear the visible transcript only (disk history and context untouched) |
| `/compact` | Force compaction now; show the new digest (§6.9.4) |
| `/summary` | Show digest, turn counts, token estimate, budget headroom |
| `/pin` / `/unpin` | Pin / unpin the most recent turn |
| `/sessions` | List stored game conversations (turn count, last active); `/sessions <n>` switches |
| `/usage` | Token + cost breakdown for this session, this game, and lifetime |
| `/model [id]` | Show or change the chat model for this session (recorded in history) |
| `/export` | Copy the transcript to the clipboard or save as `.md` |
| `/forget` | Delete this game's conversation from disk (confirm required) |

Unknown `/command` → inline "unknown command — try `/help`" and the text stays in the buffer. Any other input is sent as a normal prompt (capture + stream).

---

## 7. Error Handling & Failure Modes

| # | Failure | Detection | Behaviour | Recovery |
| --- | --- | --- | --- | --- |
| 7.1 | No eligible game in foreground | Probe rejects window | Tray notification "No game window focused" | Retries on next hotkey |
| 7.2 | Capture fails | Engine error / `HRESULT` | `!! Capture failed — <reason>` in transcript | Other engine tried automatically first, then **Retry** |
| 7.3 | Black frame | Mean-luminance sampling | "Captured a black frame (game minimised or on another desktop)" | One cross-engine retry, then explicit error |
| 7.4 | Overlay hidden mid-stream | Hide event | Request aborted; partial answer kept, marked `⏹ cancelled` | — |
| 7.5 | API 401 | HTTP status | "API key rejected — open Settings" | Inline button to Settings |
| 7.6 | API 429 | Status + `Retry-After` | "Rate limited — retrying in Ns" with countdown | Auto-retry ≤ 2×, then manual **Retry** |
| 7.7 | API 5xx / network drop | Status / IO error | "Connection lost" | Auto-retry once, then manual **Retry** |
| 7.8 | Context length exceeded | API error | Compact, then retry once, notifying the player | AC-32 |
| 7.9 | Model list empty / fetch failed | Filter result | Warning + **Show all models** + manual entry | — |
| 7.10 | Hotkey already taken | `RegisterHotKey` error | Inline conflict message in the wizard | Re-record |
| 7.11 | Session file corrupt / unreadable | JSON parse / schema | Back up to `<slug>.corrupt-<n>`, start a fresh session, toast the player, **never** crash | Automatic |
| 7.12 | Config corrupt | Parse / schema failure | Back up `config.json.bak-<n>`, run the wizard with defaults | Automatic |
| 7.13 | Disk full / write denied | IO error | "Cannot save conversation — disk full"; the turn still streams and is held in memory with a **Save failed** badge | Player frees space; retry on next turn |
| 7.14 | Compaction call fails | HTTP / timeout | Non-blocking `!! compaction failed — continuing with previous context` | One retry on the next threshold crossing |
| 7.15 | Crash | Panic / abort | Next launch: "Sidekick crashed last run" + log path; session files intact (atomic writes) | — |
| 7.16 | WebView2 missing | Launch failure | Dialog with the official bootstrapper link | — |
| 7.17 | Unknown model / price | Pricing table miss | Tokens shown, cost shown as `—` | User overrides price in Settings |

**Logging** — `tracing` with daily-rotating files in `%APPDATA%\sidekick\logs\`. `error`/`warn` always, `info` normally, `debug`/`trace` only when a `verbose.log` marker file exists. **Frame bytes, API keys, and full conversation text are never logged**; keys are redacted to `sk-…last4`, session writes are logged as ids and counts only.

---

## 8. Security & Privacy

| Concern | Control |
| --- | --- |
| API key at rest | Windows Credential Manager via the `keyring` crate (service `sidekick`, user `openai`). Never in `config.json`, never sent to the webview — the UI receives only a boolean plus a masked display value |
| Credential Manager unavailable | Fall back to a DPAPI-encrypted blob (`CryptProtectData`, user scope) in `secret.bin`, surfaced in the UI as a degraded-security state |
| Key in transit | TLS only; endpoint pinned to `api.openai.com`; redirects to other hosts are not followed |
| **Server-side retention** | **Every request sends `store: false`** — the Responses API otherwise retains responses ≈30 days. Applies to chat *and* compaction calls. AC-29 |
| **Frames** | In-memory only. Never written to disk, never on the clipboard, never in logs or crash reports, never in session files (metadata only). Thumbnails are `blob:` URLs revoked on hide/reset |
| **Conversation text** | **Persisted locally** — this is new in v1.2 and is disclosed in the wizard and in §9's notice. Stored as JSON under `%APPDATA%\sidekick\sessions\`, protected by the user profile's ACL, with optional DPAPI encryption (`encrypt_at_rest`, off by default). Never transmitted anywhere except to `api.openai.com` as request content |
| Data sent to OpenAI | The composed context (§6.6.3) and the frame. No window titles, no process history, no identifiers, no machine fingerprint, no telemetry |
| Webview hardening | Tauri v2 **capabilities** with a minimal allow-list; no `fs`/`shell`/`http` permissions beyond what is used; CSP set in `tauri.conf.json`; remote origins blocked |
| Supply chain | Pinned `Cargo.lock`; `npm ci` only; no install scripts; dependency audit before each release |
| Local telemetry | **None transmitted, ever.** Optional local counters (sessions, requests, tokens, errors, est. cost) live in `config.json` and are shown in Settings |
| Reset / deletion | **Reset all data** in Settings clears config, credentials, every session, and the log directory |

---

## 9. Product Scope: Offline, Single-Player, PvE

**Decision (owner, C11): Sidekick is built for non-competitive, offline, single-player and PvE/co-op games. It is not intended for competitive or online multiplayer titles, and its anti-cheat exposure is designed down accordingly.**

**Why this matters technically:** Sidekick captures the screen of a process that may have a kernel anti-cheat driver loaded. Anti-cheat products differ in what they inspect — injected modules, hooks, overlay windows, handle enumeration, known overlay-process signatures — and enforcement ranges from a warning to a permanent account ban. The engineering answer is not "be careful"; it is to not build a product that needs that risk.

**Hard implementation constraints**

1. **No injection.** No DLL injection, no hooking, no code patching, no `ReadProcessMemory`, and no handle to the game process beyond `GetForegroundWindow` plus process-name/path resolution.
2. **No input automation.** The pilot never synthesises mouse or keyboard input. This is a product decision, not a technical limitation.
3. **Ordinary window.** Sidekick is a standard top-level window — the same category of software as a voice chat app or a macro pad.
4. **No game-state access.** No reading of save files, memory, logs, or network traffic. Frames and the player's own words are the entire input.

**Enforcement**

| Mechanism | Behaviour |
| --- | --- |
| Wizard notice (required checkbox) | *"Sidekick captures your screen to answer your questions. It is intended for single-player, offline and PvE games. Do not use it in competitive or online multiplayer titles — some anti-cheat systems treat screen capture as cheating and can ban your account. Sidekick never injects into or reads game memory."* |
| Advisory title list | A bundled list of known competitive titles, **configurable without a release**. On match: a dismissible header warning `⚠ competitive title` plus a one-time modal. |
| `competitive_title_action` | `warn` (default) or `block`. Default `warn` because the player owns the decision; `block` is one config change away for anyone who wants a hard stop. |
| Repeat warning | Re-shown when a competitive title is focused, at most once per game per session |

**Residual (not an engineering decision):** distribution, marketing, and any public release remain the owner's call. Nothing in the code changes if that decision differs — the constraints above hold regardless.

---

## 10. Non-Functional Requirements

| Requirement | Target | Measurement |
| --- | --- | --- |
| Screen capture (probe → base64) | **< 40 ms** | `Instant` timing in the capture engine, p95 over 100 runs on the test rig |
| Hotkey → overlay visible | **< 100 ms** p95 | Hotkey callback timestamp vs. first rendered frame (`performance.now()`) |
| Enter → request dispatched | **< 80 ms** | Rust timestamp before the `reqwest` send |
| **Session load → transcript rendered** | **< 150 ms** p95 | Hotkey timestamp → first transcript paint, for a 500-turn session |
| Time to first token | **≤ 1.5 s** p50 broadband | Stream instrumentation correlated by `request_id` |
| **Compaction overhead** | **≤ 1.5 s** on the triggering turn | Digest call duration; compaction runs *before* dispatch so its latency is visible — measured and reported |
| Idle memory | **< 45 MB** RSS | Task Manager, 10 min idle after use |
| Idle CPU | **≤ 0.1 %** average | 60 s sample, Task Manager |
| Peak memory during streaming | **< 120 MB** | Sampled during a 20-turn session |
| UI-thread work | **< 4 ms** per task | Chrome DevTools trace on the overlay; no capture/encode/HTTP on the UI thread |
| FPS impact on host game | **0** attributable dropped frames | PresentMon / in-game overlay, 10 min run, idle vs. baseline |
| Capture determinism | ≤ 1 blank frame in 100 captures | Automated capture-loop harness |
| Session write durability | 0 lost writes in a 1,000-save fault-injection run | Kill process mid-write; every file must parse |
| Startup to tray-resident | < 2 s warm, < 4 s cold | Timed launch |
| Accessibility | Full keyboard operation, visible focus, text ≥ 12 px, honours reduced-transparency settings | Manual audit |

---

## 11. Test Strategy

### 11.1 Rust unit tests

- `openai/filter.rs` — allowlist/denylist truth table, tiering, empty intersection, escape hatch, cost-sort ordering
- `openai/capabilities.rs` — per-model `reasoning.effort` gating (Luna accepts `none`, Astra must not receive it)
- `openai/pricing.rs` — cost formula, cached-token discount, unknown-model `—`
- `config.rs` — schema validation, clamping, migration, corrupt-file recovery
- `session/store.rs` — key/slug derivation incl. path-hash collision case, atomic write, retention pruning, corrupt-file quarantine, round-trip of every field
- `session/compaction.rs` — eligibility selection, pinned-turn exemption, single-pass digest merge, version increment, failure leaves the previous digest intact, **compaction never alters `turns[].text`**
- `session/budget.rs` — trigger boundary conditions, token estimation calibration against reported usage, `keep_recent_images` policy
- `capture/encode.rs` — downscale thresholds, quality/size targets, base64 correctness
- `hotkey.rs` — combination parsing, conflict mapping

### 11.2 Integration tests (`tauri::test`)

- Full IPC path: wizard save → tray → hotkey → session load → capture → stream → compaction → reset
- Mocked Responses-API SSE fixture: normal stream, `response.completed` usage, mid-stream disconnect, 429 + `Retry-After`, context-length error, reasoning-token payload, unknown event type
- Compaction against a mocked endpoint: assert the next request's `input` contains the digest, excludes old frames, and includes pinned turns verbatim
- Golden-frame test: capture a known test pattern, assert dimensions and mean luminance within tolerance
- Fault injection: kill the process during session writes and during compaction; assert every file still parses

### 11.3 Manual matrix

Windowed · borderless fullscreen · exclusive fullscreen (degraded) · alt-tab mid-stream · rapid hotkey spam · two overlays in sequence · 100 consecutive requests · game restart with Sidekick running · **Sidekill restart with the game running** · **Sidekick restart with the game closed, then reopen the game** · two games alternating 20× (isolation check) · a 500-turn session (compaction + scrollback + perf) · pinning across a compaction · multi-monitor mixed DPI · 4K · HDR · minimised game · UAC prompt · corrupt session file · disk-full simulation · `store: false` verified in a network capture

### 11.4 Test-game matrix

| Game | Mode | Purpose |
| --- | --- | --- |
| Elden Ring | Borderless | Primary target (named in the PRD's own status line) |
| Cyberpunk 2077 | Borderless / windowed | High-DPI, HDR |
| Any offline single-player title | Windowed | Second session key, isolation testing |
| Notepad (non-game) | Windowed | Non-game baseline |
| Exclusive-FS title | Exclusive | Degraded-mode validation only |

### 11.5 Performance harness

A `--bench` flag runs 100 capture cycles, 20 mocked streams, and 10 simulated compaction cycles, printing p50/p95 for every budgeted operation. Committed to CI as a report rather than a hard gate (hardware variance), flagging any > 20 % regression.

---

## 12. Acceptance Criteria

### Configuration & lifecycle

| ID | Scenario | Pass condition |
| --- | --- | --- |
| AC-01 | First boot, no config | Wizard opens; tray icon **does not** exist until setup completes |
| AC-02 | Model fetch with invalid key | Inline 401 error; model select stays disabled; no crash |
| AC-03 | Model fetch with valid key | Only allowlisted multimodal models; `gpt-6-luna` present; embeddings/tts/whisper/codex/realtime absent |
| AC-04 | Complete setup | Key in Credential Manager, config persisted, wizard hidden, tray resident, hotkey works |
| AC-05 | Hotkey with game focused | Overlay visible < 100 ms p95; header shows correct process name |
| AC-06 | Hotkey with no game focused | No overlay; tray notification explains why |
| AC-07 | Submit prompt | Frame captured (badge shows real dimensions/size/engine), request dispatched < 80 ms, tokens stream |
| AC-08 | Frame never hits disk | A full capture+stream cycle leaves no new image files anywhere under `%APPDATA%\sidekick` (automated check) |
| AC-09 | Key never in config | `config.json` and session files contain no key material (grep-based test) |
| AC-10 | `Escape` mid-stream | Request aborted (truncated SSE observable), partial answer kept and marked cancelled |
| AC-11 | `Escape` while idle | Overlay hides; the game window regains keyboard focus |
| AC-12 | `Ctrl+L` | Visible transcript cleared; on-disk history and context **unchanged** |
| AC-13 | `↑` / `↓` | Last 20 prompts for this session, in order |
| AC-14 | Windowed / borderless game | WGC path used; full support |
| AC-15 | Exclusive fullscreen game | Degraded mode with an explicit explanation; no crash; no black frame silently sent |
| AC-16 | Black frame / minimised game | Detected, retried once cross-engine, then explicit error |
| AC-17 | 429 from API | Countdown shown, ≤ 2 auto-retries, then manual **Retry** |
| AC-18 | Tray → Settings | Values pre-filled; key masked; raw key never reaches the webview |
| AC-19 | Hotkey conflict | Save blocked on that field with a clear "in use" message |
| AC-20 | Idle footprint | ≤ 45 MB RSS and ≤ 0.1 % CPU over 60 s after a session |
| AC-21 | Second launch | Existing instance focused; no duplicate tray icon |
| AC-22 | Crash then relaunch | Crash notice with log path; every session file still parses |

### Sessions, context & compaction

| ID | Scenario | Pass condition |
| --- | --- | --- |
| AC-23 | Per-game isolation | 20 alternating prompts across two games produce two disjoint transcripts and two disjoint contexts; no cross-contamination in any request payload |
| AC-24 | Resume after game restart | Same game, Sidekick running throughout: transcript, digest, and counters restored exactly |
| AC-25 | Resume after Sidekick restart | Sidekill quit and relaunched while the game stays open: same transcript and context; header shows `resumed` |
| AC-26 | Resume after machine reboot | Same guarantees as AC-25 across a full process and machine restart |
| AC-27 | First-ever session | A new game creates its session lazily on the first prompt, not on hotkey press |
| AC-28 | Compaction trigger | Crossing the budget compacts before dispatch; overlay shows `[context compacted · N → 6 turns · digest vM]`; the answer still arrives |
| AC-29 | **`store: false`** | Every request to `/v1/responses`, chat and compaction, carries `store: false` — verified by network capture |
| AC-30 | Compaction preserves history | After compaction, every pre-compaction turn is still present and unedited in the scrollback and on disk |
| AC-31 | Pinned turns survive | A pinned turn from 40 turns ago is still sent verbatim after two compactions |
| AC-32 | Context-length overrun | An injected context-length error triggers compaction + one retry, and the turn succeeds |
| AC-33 | Frame policy in context | Exactly `keep_recent_images` + the current query carry frames; older frames are absent from the payload and replaced by stubs; frame metadata survives in the transcript |
| AC-34 | Compaction failure is non-fatal | With the compaction endpoint failing, the player's turn still streams, with a non-blocking warning, and the previous digest is intact |
| AC-35 | Atomicity | Killing the process during session writes and during compaction leaves every file parseable; no turn is lost |
| AC-36 | Commands | `/help /new /clear /compact /summary /pin /unpin /sessions /usage /model /export /forget` all behave as specified; no command triggers a capture or an API call except `/model` and `/compact` |
| AC-37 | Usage & price | Footer shows tokens + elapsed + estimated price per answer; `/usage` shows session, per-game and lifetime totals; an unknown model shows `—` rather than a guess |
| AC-38 | Retention | Sessions beyond the 50 most recent are pruned; the 1 MB per-file cap produces a visible notice |
| AC-39 | Delete / export | `/forget` removes the game from disk; `/export` writes a `.md` transcript; **Reset all data** empties config, credentials, sessions and logs |
| AC-40 | Competitive-title handling | A listed title triggers the warning in `warn` mode and a refusal in `block` mode |

### Host-application safety

| ID | Scenario | Pass condition |
| --- | --- | --- |
| AC-41 | No injection | Codebase contains no `WriteProcessMemory`, `CreateRemoteThread`, `SetWindowsHookEx`, or `ReadProcessMemory`; enforced by a CI grep gate |
| AC-42 | Idle in-game for 10 min | 0 attributable dropped frames; overlay never steals focus on its own |

---

## 13. Milestones & Definition of Done

| Milestone | Content | Exit criteria |
| --- | --- | --- |
| **M0 — Scaffold** | Git workflow, Tauri v2 + React + TS + Tailwind, capabilities, tray shell, logging, CI | Builds clean; `tauri dev` shows an empty transparent always-on-top window; unit-test harness green; CI grep gate for AC-41 in place |
| **M1 — Config & lifecycle** | Config schema, Credential Manager, wizard, tray menu, single instance, hotkeys | AC-01, AC-04, AC-06, AC-18, AC-19, AC-21 |
| **M2 — Capture engine** | Window probe, WGC path, DXGI fallback, encode, black-frame detection, bench harness | AC-07 (capture half), AC-15, AC-16; capture < 40 ms |
| **M3 — Overlay REPL** | Overlay window, anchor/geometry, focus return, PEEK mode, transcript, markdown streaming, frame badge, `/help` | AC-05, AC-10, AC-11, AC-12, AC-13 |
| **M4 — AI pipeline** | Responses API client, SSE streaming, model filter + cost sorting + capability map + pricing, context assembly, usage footer | AC-02, AC-03, AC-07, AC-08, AC-09, AC-14, AC-17, AC-29, AC-37 |
| **M5 — Sessions & context engine** | Per-game session store, atomic persistence, resume, digest + compaction, budget enforcement, pinning, full slash-command surface, tray Sessions menu | AC-23 … AC-36, AC-38, AC-39, AC-40 |
| **M6 — Hardening** | Full error matrix, crash recovery, DPI/multi-monitor, idle footprint, 100-request soak, 500-turn session soak, fault injection | AC-20, AC-22, AC-35, AC-41, AC-42 + the whole §11.3 matrix |
| **M7 — Ship** | Signed NSIS installer, updater, README/usage docs, pilot build | Installer runs clean on a fresh machine; AC-01 … AC-42 pass |

**Definition of Done (per milestone):** reviewed · unit tests for new logic · `cargo clippy -- -D warnings` clean · `cargo fmt --check` clean · no high/critical `npm audit` findings · milestone acceptance criteria demonstrated on the test rig · **this PRD updated if reality diverged from it** · one commit per milestone on `main` via a PR.

---

## 14. Decisions

### 14.1 Resolved

| ID | Decision | Rationale | Date |
| --- | --- | --- | --- |
| D2 | **Offline / single-player / PvE only.** Competitive online titles are out of scope; advisory warning list with a `warn`/`block` switch | Owner's product decision. Removes the dominant risk class rather than trying to manage it | 2026-10-04 |
| D3 | **Responses API** (`/v1/responses`), streaming, `store: false` | Current OpenAI surface; supports reasoning-effort control; `store: false` gives us the privacy posture v1.0 wanted | 2026-10-04 |
| D4 | **Cheapest models.** Default `gpt-6-luna` ($0.10/$0.50); picker cost-sorted; compaction on the cheapest model | 100× cheaper than `gpt-6-astra` with ample quality for this task; tagged "Default" by OpenAI for high-volume work | 2026-10-04 |
| D6 | **Continuous context with compaction**, replacing the fixed 3-turn window | A fixed window either forgets or grows unbounded; compaction gives unbounded conversation at bounded latency and cost | 2026-10-04 |
| D9 | **No cost guardrails.** Display-only usage and pricing in the overlay | It is the player's key and their spend; guardrails would be paternalistic. Visibility is the right answer | 2026-10-04 |
| D10 | **Git repository** on branch `main`; Conventional Commits; CI from day one | Needed for the milestone PR workflow and the CI grep gate | 2026-10-04 |
| D12 | **Explicit history, not `previous_response_id`** | Compaction must prune deterministically and drop images; `store: false` removes server-side chaining anyway | 2026-10-04 |
| D13 | **Transcript and context are separate stores** | Compaction must never be able to destroy player history | 2026-10-04 |
| D14 | **Compaction threshold 12,000 tokens**, far below the 1.05 M window | Bought as a coherence and latency optimisation, not for capacity; costs ~$0.0012 per request at Luna rates | 2026-10-04 |

### 14.2 Still open

| ID | Question | Options | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| **D1** | Filter maintenance | (a) hard-coded regex, (b) remote list, (c) hard-coded + "Show all models" | **(c)** for the pilot | Nothing — the escape hatch de-risks it |
| **D5** | Default hotkey | `Alt+Space` vs `Ctrl+Shift+Space` | **`Alt+Space`** with conflict detection — matches launcher muscle memory | — |
| **D7** | Click-through | Whole-window `[PEEK]` mode vs none | **Keep `[PEEK]`** — pixel-accurate is unavailable in Tauri v2 | M3 |
| **D8** | Distribution | Signed NSIS / winget / store | **Signed NSIS first**, winget after pilot | M7 |
| **D11** | `gpt-6.1-sol` pricing | Verify against `developers.openai.com/api/docs/pricing` during M4 and fill the table | **Verify in M4**; until then Sol shows tokens with `—` cost | M4 |
| **D15** | Transcript encryption default | Off (plain JSON, profile ACL) vs on (DPAPI) | **Off**, with a one-click toggle — plaintext keeps export, grep, and debugging sane; the API key is always in Credential Manager regardless | M5 |
| **D16** | Session title generation | First prompt truncated vs a cheap model-generated title | **Truncated first prompt for the pilot**; model-generated titles are a cheap post-pilot win | M5 |
| **D17** | Archive vs delete for `/new` | Keep archived copies vs discard | **Archive to `sessions/archive/`** with a 50-file cap | M5 |

### 14.3 Assumptions

| ID | Assumption |
| --- | --- |
| A1 | Windows 10 1809+ / 11, x64, WebView2 runtime present or bootstrapped by the installer |
| A2 | The player owns an OpenAI API account and pays their own usage; Sidekick bundles or resells nothing |
| A3 | Target games run windowed or borderless fullscreen; exclusive fullscreen is explicitly degraded |
| A4 | Test rig is a single-GPU mid-range gaming PC; hybrid graphics / multi-GPU is out of pilot scope |
| A5 | Rust 1.99, Node 22, npm 12 available (verified present) |
| A6 | `/v1/models` still exposes no per-model capability metadata (true as of 2026-10-04) |
| A7 | `windows-capture` 2.x and the `windows` crate's DDA bindings stay compatible with the pinned toolchain |
| A8 | Players read English in the overlay; i18n is post-pilot |
| A9 | Single local user session; no RDP or multi-user support |
| A10 | No telemetry is transmitted in the pilot |
| A11 | Conversation persistence is desirable and consented to — disclosed in the wizard notice and §8 |
| A12 | Per-game isolation keyed by executable is sufficient granularity; per-save-file or per-playthrough isolation is **not** required |
| A13 | `tiktoken-rs` can approximate GPT-6-family tokenisation well enough for a soft threshold, with the API's reported usage as the calibration source of truth |

---

## 15. Technical Architecture

### 15.1 File layout

```
sidekick/
├── docs/
│   ├── PRD.md                     # this document
│   └── adr/                       # one ADR per decision in §14
├── .github/workflows/ci.yml       # fmt, clippy, tests, AC-41 grep gate
├── src/                           # React + Vite + TypeScript + Tailwind
│   ├── main.tsx
│   ├── App.tsx                    # wizard | settings | overlay, driven by window label
│   ├── components/
│   │   ├── config/                # OpacitySlider, SizeSliders, ApiKeyField, ModelSelect,
│   │   │                          # HotkeyRecorder, IntegrityNotice, AnchorSelect, UsagePanel
│   │   ├── repl/                  # ReplTranscript, PromptInput, CommandSuggestions,
│   │   │                          # FrameBadge, StatusBar, MarkdownStream, CostFooter,
│   │   │                          # ContextMeter, CompactionNotice, ErrorBlock, PinToggle
│   │   └── sessions/              # SessionsList (tray-driven)
│   ├── state/
│   │   ├── overlayMachine.ts      # reducer: idle | capturing | streaming | compacting | error
│   │   └── viewStore.ts           # read-model mirroring Rust state (never authoritative)
│   ├── hooks/
│   │   ├── useTauriStream.ts      # stream-token / done / error / context-compacted listeners
│   │   ├── useSession.ts          # session load/hydrate
│   │   └── useConfig.ts
│   ├── lib/
│   │   ├── ipc.ts                 # typed invoke() wrappers — the ONLY IPC surface
│   │   ├── commands.ts            # slash-command parser and dispatch table
│   │   └── format.ts
│   └── styles/                    # repl.css (scanlines, blur, reduced-transparency), tailwind.css
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json            # window defs, CSP, NSIS bundler, updater
    ├── capabilities/              # wizard.json, settings.json, overlay.json — narrowest sets
    ├── icons/
    └── src/
        ├── main.rs                # entry, single-instance, window labels
        ├── lib.rs                 # run(): builder, plugins, tray, hotkey, IPC registration
        ├── error.rs               # AppError → { code, message, hint, retryable }
        ├── app_state.rs           # config, active session, capture engine, cancel tokens, counters
        ├── config.rs              # serde schema, defaults, clamping, migration, atomic save
        ├── secrets.rs             # keyring → Credential Manager, DPAPI fallback
        ├── tray.rs                # icon, menu, dynamic enable/disable, Sessions submenu
        ├── hotkey.rs              # register/unregister/parse, conflict mapping
        ├── overlay.rs             # anchor, geometry, focus return, PEEK mode, adaptive transparency
        ├── usage.rs               # token accounting, cost formula, per-session/lifetime totals
        ├── telemetry.rs           # local-only counters
        ├── capture/
        │   ├── mod.rs             # CaptureEngine trait + engine selection + serialized worker
        │   ├── window_probe.rs    # GetForegroundWindow, process name/path, client rect, DPI
        │   ├── wgc.rs             # windows-capture path (windowed/borderless)
        │   ├── dxgi.rs            # Desktop Duplication path (exclusive FS), cached handles
        │   ├── luminance.rs       # black-frame heuristic
        │   └── encode.rs          # crop, downscale, JPEG q85, base64 data URI
        ├── openai/
        │   ├── mod.rs
        │   ├── client.rs          # Responses API: streaming SSE, store:false, cancel, retries, timeouts
        │   ├── filter.rs          # multimodal allowlist/denylist (pure, unit-tested)
        │   ├── capabilities.rs    # per-model reasoning-effort / context-window / endpoint support
        │   ├── pricing.rs         # built-in table + user overrides + cost formula
        │   └── types.rs           # request/input-array/SSE-event types
        ├── session/
        │   ├── mod.rs
        │   ├── store.rs           # load/save/atomic write, slug + path hash, retention, quarantine
        │   ├── identity.rs        # process → (key, exe_path_hash, slug) resolution
        │   ├── context.rs         # input assembly: system + digest + pinned + recent window + query
        │   ├── budget.rs          # tiktoken-rs estimation, calibration, trigger decision
        │   ├── compaction.rs      # eligibility, digest call, versioned atomic commit, failure paths
        │   ├── digest.rs          # digest prompt + single-pass merge
        │   └── titles.rs          # session titles (truncated first prompt)
        └── ipc.rs                 # every #[tauri::command] in one auditable surface
```

### 15.2 IPC contract

**Commands** (webview → Rust; Rust authoritative)

| Command | Args | Returns |
| --- | --- | --- |
| `config_load` | — | `Config` (never includes the key; `has_api_key: bool`) |
| `config_save` | `Config` | `()` — validates, then writes credential + file atomically |
| `secrets_set_api_key` / `secrets_clear_api_key` | `api_key: String` / — | `()` |
| `models_validate_key` | `api_key: String` | `{ ok: bool, error?: AppError }` |
| `models_list` | — | `{ models: ModelEntry[], total, filtered_out, unknown_pricing }` |
| `hotkey_register` | `combo: String` | `{ ok: bool, conflict?: String }` |
| `overlay_toggle` | — | `{ visible: bool, target?: string, session?: SessionSummary }` |
| `overlay_set_mode` | `interactive \| peek` | `()` |
| `overlay_set_geometry` | `{ width, height, anchor, opacity }` | `()` |
| `prompt_send` | `{ text: String }` | `{ request_id }` — session resolve → budget check → compaction → capture → dispatch |
| `prompt_abort` | `request_id` | `()` |
| `session_list` | — | `SessionSummary[]` (key, title, turns, updated_at, pinned_count) |
| `session_open` | `slug` | `SessionDetail` — loads and hydrates the overlay |
| `session_new` | `{ archive: bool }` | `SessionDetail` |
| `session_delete` | `slug` | `()` — `/forget` |
| `session_reset_current` | — | `()` — tray **Reset Session** |
| `session_export` | `format: "clipboard" \| "markdown"` | `{ path? }` |
| `session_set_pin` | `{ turn_id, pinned }` | `()` |
| `context_status` | — | `{ turns, digest_version, est_tokens, budget, compacted_turns }` |
| `context_force_compact` | — | `{ ok, digest, version, est_tokens }` |
| `usage_summary` | `scope: "request" \| "session" \| "game" \| "lifetime"` | `{ input, output, reasoning, cached, est_cost_usd, model, price_basis }` |
| `app_diagnostics` | — | `{ version, os, gpu, idle_rss_kb, log_dir, sessions_dir, uptime_s }` |
| `app_reset_all_data` | — | `()` — config, credentials, sessions, logs |
| `app_quit` | — | `()` |

**Events** (Rust → webview)

| Event | Payload |
| --- | --- |
| `sidekick://stream-token` | `{ request_id, delta }` |
| `sidekick://stream-done` | `{ request_id, usage, latency_ms, est_cost_usd, model }` |
| `sidekick://stream-error` | `{ request_id, error: AppError, retryable }` |
| `sidekick://frame-captured` | `{ request_id, index, width, height, engine, bytes, encode_ms, detail }` |
| `sidekick://context-compacted` | `{ request_id?, from_turns, to_turns, digest_version, removed, est_tokens }` |
| `sidekick://session-changed` | `{ slug, key, title, turns, resumed, created }` |
| `sidekick://overlay-state` | `{ visible, mode, target_process, target_title, advisory? }` |
| `sidekick://config-changed` | `Config` |
| `sidekick://usage-updated` | `{ input, output, reasoning, cached, est_cost_usd }` |

**Rules:** every command validates input and returns `Result<T, AppError>`; `AppError` carries `{ code, message, hint, retryable }` so the UI never parses strings. Blocking work (capture, encode, session IO) runs in `spawn_blocking` behind a mutex so no two captures or two session writes overlap.

### 15.3 Config schema (`%APPDATA%\sidekick\config.json`)

```jsonc
{
  "schema_version": 2,
  "window": { "width": 480, "height": 620, "opacity": 0.85, "anchor": "top-right", "margin": 24 },
  "overlay": { "mode": "interactive", "reduced_transparency": "auto" },
  "ai": {
    "provider": "openai",
    "model": "gpt-6-luna",
    "compaction_model": "gpt-6-luna",
    "detail": "auto",
    "max_output_tokens": 700,
    "reasoning_effort": "none"
  },
  "context": {
    "budget_tokens": 12000,
    "recent_window_exchanges": 6,
    "keep_recent_images": 1,
    "digest_max_words": 250,
    "compaction_max_output_tokens": 400
  },
  "sessions": { "max_sessions": 50, "max_bytes_per_file": 1048576, "encrypt_at_rest": false,
                "prompt_history_depth": 20 },
  "capture": { "engine": "auto", "jpeg_quality": 85, "max_dimension": 1920, "black_frame_retry": true },
  "hotkey": "Alt+Space",
  "autostart": false,
  "competitive_title_action": "warn",
  "integrity_notice_accepted_at": "2026-10-04T19:00:00Z",
  "pricing": { "gpt-6-luna": { "input": 0.10, "cached_input": 0.01, "output": 0.50 },
               "gpt-6-astra": { "input": 10.00, "cached_input": 1.00, "output": 50.00 } },
  "local_counters": { "sessions": 0, "requests": 0, "tokens_in": 0, "tokens_out": 0, "est_cost_usd": 0.0, "errors": 0 }
}
```

Unknown keys are preserved on save (forward compatibility). Writes are atomic; the last known-good config is kept as `config.json.bak-<n>`. `schema_version` drives migrations.

### 15.4 Threading model

| Thread / task | Responsibility |
| --- | --- |
| Main (UI) | Tauri, tray, hotkey callbacks. **Never** captures, encodes, does HTTP, or touches session files |
| Capture worker (`spawn_blocking`, dedicated, **serialized**) | Probe → engine → crop → encode → base64. Caches DDA handles and the WGC session |
| Session IO (`spawn_blocking`, **serialized**) | Load, atomic save, prune, quarantine |
| HTTP task (Tokio, one per `request_id`) | Responses API SSE reader → `Emitter::emit` per delta; honours the request's `CancellationToken` |
| Compaction task (Tokio, on demand) | Digest call before dispatch; runs **ahead of** the player's request so its latency is measurable, never silently blocking |
| Frontend | Render-only. All state arrives via events; `state/overlayMachine.ts` is the only writer |

### 15.5 Key dependencies (pinned)

| Purpose | Crate / package |
| --- | --- |
| WGC capture | `windows-capture` (2.x) |
| DXGI fallback + Win32 APIs | `windows` |
| Async runtime / HTTP / SSE | `tokio`, `reqwest` (`rustls`, `stream`) |
| Serialization | `serde`, `serde_json` |
| Secrets | `keyring` (Credential Manager), DPAPI fallback |
| Logging | `tracing`, `tracing-subscriber`, `tracing-appender` |
| Image | `image` (crop/resize/encode) |
| Token estimation | `tiktoken-rs` (soft budgeting; API-reported usage is the truth) |
| Frontend | `react`, `react-dom`, `vite`, `typescript`, `tailwindcss` |
| Tauri plugins | `global-shortcut`, `store`, `single-instance`, `autostart`, `updater`, `opener` |

---

## 16. Review Checklist

Please confirm or correct before development begins:

1. **§9 scope** — offline / single-player / PvE only, with an advisory (not blocking) competitive-title warning. Is `warn` the right default, or do you want `block`?
2. **§6.9 context budget** — 12,000-token soft threshold, 250-word digest, 6 verbatim exchanges, 1 retained frame. Tune, or leave on defaults?
3. **§6.8 persistence** — conversations stored as plain JSON under `%APPDATA%\sidekick\sessions\`, 50 sessions retained, `/new` archives. Comfortable with plaintext, or DPAPI by default (D15)?
4. **§6.7 model choice** — `gpt-6-luna` default, cost-sorted picker, and `gpt-6.1-sol` pricing still to be verified in M4 (D11). Want a different default?
5. **§6.10 commands** — is the slash-command surface right, and is `/export` (clipboard / `.md`) acceptable as the only data-exit path?
6. **§13 milestones** — is M0–M7 the right order, or should sessions/compaction ship earlier?
7. **Repo** — the git repo is on `main` with placeholder identity `Sidekick Dev <dev@sidekick.local>`. Replace it with your real identity before the first commit?
8. **Anything missing** — features, constraints, or hardware/OS realities I have not accounted for.
