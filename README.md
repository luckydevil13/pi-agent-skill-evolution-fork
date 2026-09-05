# pi-skill-evolution

Hermes Agent-style automated skill creation and evolution for Pi Agent.

Pi Agent already has a great skills system and extension API, but lacks the
closed-loop "auto-create, auto-modify, evolve skills" capability that Hermes
Agent achieves through `background_review` and `skill_manage`. This repo fills
that gap on top of Pi's event-driven architecture.

## What it does

| Capability | Description |
| ------------ | ------------- |
| Auto-create skills | After a complex task, the agent saves the workflow as a skill via `skill_manage` |
| Auto-patch skills | When an existing skill can be improved, uses `patch` for minimal, safe edits |
| Background review loop | After each session, the agent self-audits and decides whether to save/update skills |
| Progressive disclosure | Only skill names + descriptions sit in the system prompt; full content loads on demand |
| **Usage tracking** | Every `skill_manage` call records usage count + timestamp in `.skill-stats.json` |
| **Weekly inactive-skill reminder** | Every 7 days, Pi reminds you about skills unused for 30+ days |
| **Disable/enable skills** | Rename a skill dir to `.disabled-<name>` so Pi stops discovering it, without deleting it |

## Files

```
pi-skill-evolution/
├── README.md                      ← this file (EN)
├── README_ZH.md                   ← 中文说明
├── extensions/
│   └── skill-evolution.ts         ← Pi extension: skill_manage tool + review loop
├── skill-authoring/
│   └── SKILL.md                   ← Skill authoring playbook for the agent
└── LICENSE
```

## Installation

### Via npm (recommended)

```bash
pi install npm:pi-agent-skill-evolution
```

This installs the published npm package, which bundles the extension and the authoring skill. Pi auto-discovers both — no settings changes needed.

Browse the package gallery at [pi.dev/packages](https://pi.dev/packages).

### Direct copy (lightweight)

```bash
# Extension
cp extensions/skill-evolution.ts ~/.pi/agent/extensions/

# Authoring skill (recommended)
mkdir -p ~/.pi/agent/skills/skill-authoring
cp skill-authoring/SKILL.md ~/.pi/agent/skills/skill-authoring/
```

Pi auto-discovers both — no settings changes needed.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_SKILL_EVOLUTION_DIR` | `~/.pi/agent/skills/` | Directory where skills are stored |

## How it works

### Usage statistics

Every time the LLM calls `skill_manage` (create, edit, patch, inspect, delete, list), the extension records:

- **Count** — total number of successful invocations
- **lastUsed** — ISO timestamp of the most recent successful call
- **description** — latest description passed (for create/edit)

Data is stored in `~/.pi/agent/skills/.skill-stats.json` and persists across sessions.

### Weekly inactive-skill reminder

On every `session_start`, the extension checks:

1. Is the reminder enabled? (default: **yes**)
2. Has it been ≥ 7 days since the last check?
3. Are there any skills that haven't been used in ≥ 30 days?

If all three pass, Pi sends a follow-up message listing inactive skills with suggestions to disable/remove them. The reminder can be toggled persistently via the `/skill-evolution` command (see below).

### Disable / enable skills

Instead of deleting a skill you may want to keep, you can **disable** it:

- `disable` renames `<name>/` → `.disabled-<name>/`, so Pi's skill discovery skips it
- `enable` renames it back, restoring it to active status
- Disabled skills still appear in stats but are excluded from `skill_manage list` and the inactive reminder scan

### `skill_manage` tool

The extension registers a `skill_manage` tool callable by the LLM:

| Operation | Required params | What it does |
| ----------- | ---------------- | -------------- |
| `create` | `skillName`, `description`, `content?` | Creates a new skill |
| `edit` | `skillName`, `description`, `content` | Full rewrite of an existing skill |
| `patch` | `skillName`, `find`, `replace?` | Exact find-and-replace inside SKILL.md (preferred — safest) |
| `delete` | `skillName` | Removes a skill |
| `list` | — | Lists all available skills |
| `inspect` | `skillName`, `content?` | Reads current skill content |

Skill names are validated per the Agent Skills spec: 1–64 chars, lowercase letters,
digits, hyphens only, no leading/trailing/consecutive hyphens.

### System prompt injection

On `before_agent_start`, appends:

> After completing a complex task (5+ tool calls), fixing a tricky error, discovering
> a non-trivial workflow, or recovering from an unexpected failure, save the approach
> as a skill using the skill_manage tool so you can reuse it next time.

### Background review loop

On `agent_settled` (every 10th settled event), sends a brief one-line follow-up prompt that asks the agent to review the completed session and create or patch skills with `skill_manage`. The message is kept minimal (single line with timestamp) so it does not clutter the conversation history.

You can also trigger a review manually at any time with `/skill-evolution review now`.

### `/skill-evolution` command (extended)

The `/skill-evolution` slash command now supports subcommands for managing
usage tracking and inactive-skill reminders. All settings are persisted to
`.skill-stats.json` and survive Pi restarts.

| Command | What it does |
| --------- | ------------ |
| `/skill-evolution review now` | Manually trigger a skill review session |
| `/skill-evolution reminder on` | Enable weekly inactive-skill reminder (default) |
| `/skill-evolution reminder off` | Disable the weekly reminder |
| `/skill-evolution reminder status` | Show whether reminders are on/off + last check time |
| `/skill-evolution reminder check` | Manually trigger an inactive-skill scan right now |
| `/skill-evolution inactive` | List skills unused for 30+ days |
| `/skill-evolution stats` | Show usage count + last-used for every tracked skill |
| `/skill-evolution disable <name>` | Rename `<name>/` → `.disabled-<name>/` (Pi stops discovering it) |
| `/skill-evolution enable <name>` | Rename `.disabled-<name>/` → `<name>/` (restore it) |
| `/skill-evolution` (no args) | Show help with all available subcommands |

Disabled skills are excluded from:

- `skill_manage list` results
- The weekly inactive-skill reminder scan
- Pi's skill auto-discovery (they don't appear in the system prompt)

They are still tracked in usage stats and can be re-enabled at any time.

### Skill authoring playbook

`skill-authoring` is a model-invoked skill that auto-loads when the agent uses
`skill_manage`. Covers:

- Name rules, description best practices, leading words
- Information hierarchy (step / reference / external reference)
- Progressive disclosure and when to split skills
- Failure modes: premature completion, duplication, sediment, sprawl, no-op
- `skill_manage` operation cheat sheet with preference order: patch loaded → patch existing → create

## Hermes Agent vs pi-skill-evolution

| Dimension | Hermes Agent | pi-skill-evolution |
| ----------- | ------------- | ------------------- |
| Review trigger | Daemon thread (`spawn_background_review`) | `agent_settled` event + `sendUserMessage` followUp |
| Skill management | Python `skill_manager_tool.py` | TypeScript `pi.registerTool()` |
| Prompt injection | `prompt_builder.py` hardcoded layer | `before_agent_start` event chain |
| Skill format | agentskills.io `SKILL.md` | agentskills.io `SKILL.md` |
| Review agent | Separate sub-agent instance | Reuses main agent loop |

Pi's implementation is cleaner — no extra agent instances needed, fully leverages
Pi's existing event-driven architecture and session system.

## Development

### Test the extension standalone

```bash
pi --extension /path/to/extensions/skill-evolution.ts

pi --extension /path/to/extensions/skill-evolution.ts \
   -p "List all skills with skill_manage"
```

### Publish a new version

The project is published as `pi-agent-skill-evolution` on npmjs.
To release a new version:

```bash
cd pi-skill-evolution
npm version patch     # or minor/major
npm publish
```

The `pi-package` keyword in `package.json` ensures it appears on [pi.dev/packages](https://pi.dev/packages).

## Compatibility

Requires Pi Agent ≥ 0.80 (needs `pi.registerTool()` dynamic registration and the
`agent_settled` event).
