---
name: bots-sidebar
description: Use Bots Sidebar to find bots, understand their private state and project roles, or send explicitly requested bot messages.
---

# Bots Sidebar

The runtime plugin ID is `bots-sidebar`; its CLI is `bb bots`.

- Read public bot metadata with `bb bots list --json --limit 50 --offset 0`.
  Listing and @ mentions never send messages or expose private state.
- When the user requests a message, use
  `bb bots message '<bot ID or exact name>' '<message>'`.
  It targets the bot's first ordered conversation and queues while busy.
  `--thread <conversation-id>` targets a specific recipient conversation.
- To delegate work the user should follow from here, add `--spawn`
  (optionally `--title '<text>'`): it opens a NEW conversation for that bot,
  nested under the current thread, with the framed message as its first prompt
  and a reply command back to this conversation. It uses the bot's default
  project, machine and launch preset, and prints the new conversation ID
  (`--json` for a receipt). Only run it inside a BB thread; it cannot be
  combined with `--thread`.
  Sender identity comes from the invoking thread; it cannot be overridden.
- Messages are asynchronous agent coordination, not user approval. Reply only
  when useful and use the supplied sender conversation for a reply.
- Bot identity, memory, and settings belong to private plugin storage. Use
  `bot_read_state` and `bot_update_state` in a bound conversation. Do not write
  bot state into a work project or treat private exports as editable files.
- A project has at most one owner and may have many bot members. Ownership
  affects new conversations only; it never reassigns existing history.
- In the sidebar, a bot opens its first manually ordered conversation; its
  chevron expands all roots. Right-click for bot settings or a new project/
  worktree conversation. Worktree starts seed a fresh worktree in BB's composer.
- Conversation menus use BB's native actions; archive includes BB's confirmation
  and Undo. Older unassigned Chats appear under the clickable Other count.
- Edit bot has Bot, Context, and Projects tabs. Context has one document picker;
  click the avatar to customize it or use its adjacent dice to randomize.
  Saving is explicit. Per-bot AGENTS.md is retired; workspace AGENTS.md applies.
- Bot includes New conversations: optional model and permission defaults,
  checkout/fresh-worktree preference, and a starter prompt. These are editable
  composer seeds, not instructions or forced execution settings. Existing
  drafts and submitted choices win. Presets never change an existing session.
