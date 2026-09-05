---
name: skill-authoring
description: Write and maintain agent skill packages safely.
disable-model-invocation: true
---

# Skill Authoring

Use this playbook when `/skill:skill-authoring` is invoked or when the isolated skill reviewer evaluates a proposal.

## 1. Inspect before writing

Read the current `SKILL.md` and every package file that the proposed change touches. Check both `global` and `project` scope for the same skill name.

**Complete when:** the target scope, existing package, and every affected file are known.

## 2. Choose invocation mode

- **Model-invoked:** keep trigger branches in `description`.
- **User-invoked:** set `disable-model-invocation: true` and use a human-facing one-line description.
- Use model invocation only when the agent or another skill must discover the skill without a direct command.

**Complete when:** the proposal states the invocation mode and why it needs that mode.

## 3. Design the description

For a model-invoked skill, the description is a context pointer:

- State the capability.
- Name one trigger per distinct branch.
- Remove synonyms that repeat one branch.
- Keep it at 1024 characters or less.
- Quote it as a YAML scalar.

Change `description` only when capability, trigger branches, or invocation mode changes.

**Complete when:** each trigger branch has one clear trigger and no duplicate wording.

## 4. Design the body

Order information by need:

1. Steps the agent performs.
2. Reference rules used during those steps.
3. External references needed by only some branches.

Every step must end with a checkable completion criterion. Keep definitions, rules, and caveats for one concept under one heading.

**Complete when:** every step has a clear end condition and branch-only reference is behind a relative context pointer.

## 5. Prune

Check the proposed package for:

- **Duplication:** one meaning has more than one source of truth.
- **Sediment:** stale instructions remain after behavior changed.
- **Sprawl:** the main file contains branch-specific reference.
- **No-op:** an instruction does not change model behavior.
- **Negation:** a prohibition can be replaced by a positive target behavior.

**Complete when:** each remaining instruction changes behavior and has one authoritative location.

## Safe management workflow

`skill_evolve` reviews completed agent runs in isolated context and creates proposals. `skill_manage` applies approved proposals.

- `list` and `inspect` are read operations.
- A direct `patch` can change only one unique occurrence in the body of `SKILL.md`.
- `create`, `edit`, frontmatter changes, package-file writes, and disable operations require a proposal.
- `edit` preserves frontmatter fields that the proposal does not change.
- `global` is for reusable workflows. `project` is for repository-specific rules.
- Reload discovery data manually after create, description changes, invocation-mode changes, disable, or enable.

**Complete when:** the proposal has an explicit scope, affected files, and a reviewable diff.
