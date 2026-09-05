---
name: skill-authoring
description: Use when creating or updating a skill with skill_manage. Covers name rules, frontmatter, description writing, leading words, progressive disclosure, and when to split skills.
---

# Skill Authoring

## Before writing — decide invocation mode

- **Model-invoked** (default): keep the description; agent fires autonomously. Costs context load.
- **User-invoked**: set `disable-model-invocation: true`; strip trigger phrasing from description. Zero context cost.
- Pick model-invocation only when the agent must reach the skill on its own, or another skill must.

## Name rules

- 1-64 characters, lowercase letters, digits, hyphens only
- No leading/trailing/consecutive hyphens
- Does NOT need to match parent directory (pi allows it)

## Description (frontmatter `description`)

Does two jobs: state what the skill is AND list branches that should trigger it.

- **Front-load the leading word** — the description is where invocation happens
- **One trigger per branch** — synonyms of one branch = duplication
- **Cut identity already in the body**
- ≤ 1024 characters
- **YAML-safe** — the description lands in frontmatter. A bare `description:` followed
  by a scalar containing `:` (colon+space) or a leading indicator (`#`, `-`, `[`, `{`,
  `:`, `>`, `|`, `&`, `*`, `!`, `%`, `@`, backtick, quotes) breaks YAML and causes
  a `Nested mappings are not allowed` warning at pi startup. Prefer phrasing that
  avoids colons entirely (e.g. `Extracts tables from PDFs. Use when working with PDFs.`
  instead of `Transactions: parse receipts`). If you must use a colon, wrap the whole
  `description` value in double quotes: `description: "Parses receipts. Steps: read, classify."`

Good: `Extracts text and tables from PDFs. Use when working with PDF documents.`
Bad: `Helps with PDFs.`

## Information hierarchy

```
1. In-skill step        — ordered action in SKILL.md, with completion criterion
2. In-skill reference   — definition/rule in SKILL.md, consulted on demand
3. External reference   — pushed behind a context pointer (linked .md file)
```

Each step ends on a **completion criterion** — checkable and exhaustive. Vague criteria cause **premature completion**.

## Progressive disclosure

Push material behind context pointers when:

- Only some branches reach it (split by branch)
- A completion criterion would tempt the agent to skip ahead (split by sequence)
- Reference material is long but needed on demand

## Leading words

Use compact pretrained concepts (`lesson`, `fog of war`, `tracer bullets`, `tight`, `red`) that anchor behavior with the fewest tokens. Reuse the same word in description AND body for reliable invocation.

## When to split

- **By invocation**: distinct leading word that should trigger independently, or another skill must reach it
- **By sequence**: when post-completion steps tempt premature completion on the current step

## Pruning

Check every line:

1. **Single source of truth** — one authoritative place for each meaning
2. **Relevance** — does it still bear on what the skill does?
3. **No-op test** — does it change behavior vs the default? If no, delete it

## Skill structure

```
skills/<name>/
├── SKILL.md          # required: frontmatter + instructions
├── GLOSSARY.md       # optional: definitions, linked from SKILL.md
├── scripts/          # optional: helper scripts
└── references/       # optional: detailed docs
```

## Using skill_manage

| Operation | When |
|-----------|------|
| `create`  | Brand new skill, not yet written |
| `edit`    | Full rewrite of an existing skill |
| `patch`   | Small find-and-replace inside SKILL.md (prefer over edit) |
| `delete`  | Remove a skill no longer needed |
| `list`    | See all available skills |
| `inspect` | Read current content of a skill before editing |

**Order of preference**: patch the currently-loaded skill → patch an existing skill in the right category → create new.

## Failure modes to avoid

- **Premature completion** — fix with sharper completion criteria first, then sequence-split
- **Duplication** — same meaning in >1 place
- **Sediment** — stale layers that settled because adding felt safe
- **Sprawl** — skill too long even when every line is live (cure: progressive disclosure + splitting)
- **No-op** — line the model already obeys by default
