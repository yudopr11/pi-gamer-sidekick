---
name: gs-loadout
description: Preload Gamer Sidekick — check capture support, bind a game window, and load the gaming companion prompt section.
---

# Gamer Sidekick loadout

Get the companion ready to read your screen in three moves.

1. `/gs setup` — checks that window enumeration and screen capture both work on this machine, and reports the result for each.
2. `/gs play` — opens a picker over the windows that can be bound, then binds the one you choose.
3. Ask a question. Nothing is captured until the answer needs the screen — the companion takes a frame with `game_frame` when your question depends on what you can see.

Not bound yet? Nothing else in this session captures anything.

## While it is live

- `/gs frames` — list captured frames with their ids, size and token cost.
- `/gs status` — what is bound, whether it is still alive, and the running frame counters.
- `/gs auto on` — put a frame on every message instead, the older behaviour.
- `/gs auto off` — go back to only capturing when it is needed.

Frames stay in the conversation once taken, so they survive a `/resume` and the
companion can refer back to one by number later. A frame is ~150 KB of session
file and ~595 image tokens, so it does not spend one on every message.

## Notes

- Conversations are the player's. This package never creates, renames or
  switches one — that is pi's business. Capture is bound to the conversation it
  was set up in, so a new conversation needs its own `/gs play`.
- The companion answers in text. It does not draw on your screen or send input to the game.
- If the capture turns out black — usually exclusive fullscreen — the question still goes through, without the frame, and the reason is noted in the reply.
- Intended for single-player, offline and PvE games.