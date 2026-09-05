# pi-skill-evolution

Skill package management and isolated skill-evolution reviews for Pi Agent.

The extension separates two responsibilities:

- **skill evolution reviewer** — reviews completed agent runs in isolated model context and writes proposals;
- **`skill_manage`** — reads skill packages and performs guarded file mutations.

The reviewer never writes a skill directly. Protected changes pass through a proposal that a human can inspect and apply.

## Behavior

### Isolated review loop

Pi counts `agent_settled` events per session. One event means that an agent run has fully finished and Pi is idle. Tool calls inside the run do not increment the counter.

After every 10 completed runs, the extension:

1. takes the next non-overlapping window of 10 runs;
2. redacts likely secrets, images, and large values;
3. asks an isolated reviewer to select relevant existing skills;
4. loads only those skill bodies into reviewer context;
5. requests strict JSON with at most three proposal drafts.

The reviewer uses `reviewModel` when configured and otherwise uses the active model. It runs through `ctx.modelRegistry.complete()`, so its prompts and responses do not enter the main conversation context. A review with no proposal produces no UI message.

The counter and review cursor are stored as non-context session entries. Reload and resume preserve them. A new session starts a new counter.

Use `/skill-evolution review now` to review all currently unreviewed runs without waiting for ten.

### Proposal workflow

Proposals have a scope, file operations, source hashes, status, and audit metadata.

```text
reviewer -> pending proposal -> human apply/reject -> skill_manage transaction
```

Statuses are `pending`, `applied`, `rejected`, and `stale`. Apply compares current files with proposal hashes. A changed file makes the proposal stale. Multi-file apply is serialized through Pi's file mutation queue and rolls back completed writes when a later operation fails.

Completed proposals are retained for 30 days. Duplicate pending proposals are not created.

### Scopes

- `global` skills: `~/.pi/agent/skills/<name>/`
- `project` skills: `<cwd>/.agents/skills/<name>/`

Project configuration, state, and mutations require a trusted project. A write operation must name its scope. Creating a name that already exists in either scope is rejected.

### Safe direct patch

The LLM can call `skill_manage patch` without a proposal only when all these conditions hold:

- scope is explicit;
- the target is `SKILL.md`;
- the exact text occurs once in the body;
- frontmatter remains byte-for-byte unchanged.

Create, full edit, frontmatter changes, package-file writes, and disable operations require a proposal.

## Installation

### Pi package

```bash
pi install npm:pi-agent-skill-evolution
```

### Direct copy

```bash
cp extensions/skill-evolution.ts ~/.pi/agent/extensions/
mkdir -p ~/.pi/agent/skills/skill-authoring
cp skill-authoring/SKILL.md ~/.pi/agent/skills/skill-authoring/
```

`skill-authoring` is user-invoked. Load it explicitly with:

```text
/skill:skill-authoring
```

## `skill_manage`

| Operation | Required input | Behavior |
| --- | --- | --- |
| `list` | none | List visible global and trusted-project skills |
| `inspect` | `skillName`; optional `scope`, `content` | Read a skill or matching section |
| `patch` | `skillName`, `scope`, `find`; optional `replace` | Unique body-only patch without proposal |
| `create` | `skillName`, `proposalId` | Apply an approved proposal containing a matching create operation |
| `edit` | `skillName`, `proposalId` | Apply an approved proposal containing a matching edit operation |
| `write_file` | `skillName`, `proposalId` | Apply an approved proposal containing a matching package write |
| `delete` | `skillName`, `proposalId` | Apply an approved disable operation; it does not purge files |

Tool failures throw errors so Pi marks the result as failed. Read output is capped at 50 KB.

## Commands

```text
/skill-evolution review now
/skill-evolution proposal list
/skill-evolution proposal show <id>
/skill-evolution proposal apply <id>
/skill-evolution proposal reject <id>
/skill-evolution stats
/skill-evolution inactive
/skill-evolution reminder on|off|status
/skill-evolution disable global|project <name>
/skill-evolution enable global|project <name>
/skill-evolution purge global|project <name>
```

`purge` is the only permanent package deletion. It requires an interactive confirmation. Discovery-changing operations do not reload Pi automatically; run `/reload` after create, description or invocation-mode changes, disable, enable, or purge.

## Configuration

Global configuration:

```text
~/.pi/agent/skill-evolution/config.json
```

Project configuration:

```text
<cwd>/.pi/skill-evolution/config.json
```

Project values override global values.

```json
{
  "reviewModel": "google/gemini-2.5-flash",
  "reviewInterval": 10,
  "maxProposals": 3,
  "inactiveDays": 30
}
```

`reviewInterval` has a minimum of 1. `maxProposals` is capped at 3.

## State

Global state is under `~/.pi/agent/skill-evolution/`. Project state is under `<cwd>/.pi/skill-evolution/`.

Each scope has separate:

- `proposals/*.json`;
- `stats.json`;
- `audit.jsonl`;
- configuration.

Reviewer failures are written to project `review-errors.log` and are not injected into the main conversation.

## Statistics and inactivity

Statistics separate three events:

- `explicitInvocation` — `/skill:name` was invoked;
- `skillLoad` — the read tool loaded that skill's `SKILL.md`;
- `managementOperations` — the package was inspected or changed.

Only invocation and load events count as activity. Management does not make a skill active. The legacy `.skill-stats.json` is deleted without migration.

For a new installation, TUI mode asks once whether weekly inactivity reminders should be enabled. Non-UI modes default them to off.

## Safety boundaries

- Project state is ignored until the project is trusted.
- Skill names and package-relative paths are validated.
- Absolute paths, `..`, and symlink escapes are rejected.
- Package operations accept text files only.
- Binary assets remain the responsibility of normal file tools.
- The system prompt contains only a short guardrail; full authoring guidance is loaded by the reviewer or `/skill:skill-authoring`.
