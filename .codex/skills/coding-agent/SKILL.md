---
name: coding-agent
description: Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control.
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },
  }
---

# Coding Agent (bash-first)

Use **bash** (with optional background mode) for all coding agent work. Simple and effective.

## ⚠️ PTY Mode Required!

Coding agents (Codex, Claude Code, Pi) are **interactive terminal applications** that need a pseudo-terminal (PTY) to work correctly. Without PTY, you'll get broken output, missing colors, or the agent may hang.

**Always use `pty:true`** when running coding agents.

## Quick Start

- One-shot:
  - `bash pty:true workdir:~/project command:"codex exec 'Your task'"`
- Background:
  - `bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Your task'"`

## Core Rules

1. Always use `pty:true`
2. Respect requested tool (Codex/Claude/OpenCode/Pi)
3. Use `workdir` to stay focused in the correct project
4. For long runs: monitor, report milestones, and report completion clearly
5. For parallel tasks: prefer multiple background sessions

## Completion Notification

For long background tasks, include a completion trigger in the prompt:

`openclaw system event --text "Done: [brief summary]" --mode now`

