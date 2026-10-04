---
name: gs-loadout
description: Preload Gamer Sidekick — check capture support, bind a game window, and load the gaming companion prompt section.
---

# Gamer Sidekick loadout

Get the companion ready to read your screen in three moves.

1. `/gs setup` — checks that window enumeration and screen capture both work on this machine, and reports the result for each.
2. `/gs play` — opens a picker over the windows that can be bound, then binds the one you choose.
3. Ask a question. A frame of the bound window is captured at submit time and attached to that turn.

Not bound yet? Nothing else in this session captures anything.

## While it is live

- `/gs frames` — list captured frames with their ids, size and token cost.
- `/gs status` — what is bound, whether it is still alive, and the running frame counters.

Every message you send while a window is bound carries a frame into the
conversation. They stay in context on later turns, so you can refer back to one
by number without re-capturing anything.

## Notes

- Conversations are the player's. This package never creates, renames or
  switches one — use `/resume` and `/rename` as usual. Capture is bound to the
  conversation it was set up in, so resuming that conversation resumes capture.
- The companion answers in text. It does not draw on your screen or send input to the game.
- If the capture turns out black — usually exclusive fullscreen — the question still goes through, without the frame, and the reason is noted in the reply.
- Intended for single-player, offline and PvE games.