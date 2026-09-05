import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * skill-evolution extension
 *
 * Gives the agent a first-class `skill_manage` tool for creating, editing,
 * patching, and deleting skills, then runs a post-turn review loop that
 * inspects each completed agent run and proactively saves noteworthy
 * workflows as skills.  Mirrors Hermes Agent's self-improvement loop.
 *
 * Also tracks skill usage statistics and provides weekly reminders about
 * inactive skills. Reminder can be toggled on/off persistently via the
 * /skill-evolution command.
 *
 * Usage:
 *   Place this file in ~/.pi/agent/extensions/skill-evolution.ts
 *   or .pi/extensions/skill-evolution.ts (project-local, trusted project).
 *   No settings changes required.  Skills are stored in
 *   ~/.pi/agent/skills/<name>/SKILL.md by default.
 */

const SKILL_GUIDANCE = `\n\n## Skill Evolution\nAfter completing a complex task (5+ tool calls), fixing a tricky error,\ndiscovering a non-trivial workflow, or recovering from an unexpected failure,\nsave the approach as a skill using the skill_manage tool so you can reuse it next time.\nWhen updating an existing skill, prefer skill_manage with operation "patch"\n(small find-and-replace) over a full rewrite.\nWhen in doubt, create a skill rather than letting a useful workflow be lost.\n`;

// ─── Stats file constants ────────────────────────────────────────────

const STATS_FILENAME = ".skill-stats.json";
const INACTIVE_DAYS = 30;
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SkillUsageEntry {
	count: number;
	lastUsed: string;
	created: string;
	description?: string;
}

interface SkillStats {
	reminderEnabled: boolean;
	lastReminderCheck: string | null;
	usage: Record<string, SkillUsageEntry>;
}

function defaultStats(): SkillStats {
	return {
		reminderEnabled: true,
		lastReminderCheck: null,
		usage: {},
	};
}

function getStatsPath(skillsDir: string): string {
	return join(skillsDir, STATS_FILENAME);
}

function readStats(skillsDir: string): SkillStats {
	const path = getStatsPath(skillsDir);
	if (!existsSync(path)) return defaultStats();
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<SkillStats>;
		return {
			reminderEnabled: parsed.reminderEnabled ?? true,
			lastReminderCheck: parsed.lastReminderCheck ?? null,
			usage: parsed.usage ?? {},
		};
	} catch {
		return defaultStats();
	}
}

function writeStats(skillsDir: string, stats: SkillStats): void {
	const path = getStatsPath(skillsDir);
	mkdirSync(skillsDir, { recursive: true });
	writeFileSync(path, JSON.stringify(stats, null, 2), "utf-8");
}

function recordSkillUsage(
	skillsDir: string,
	skillName: string,
	_operation: string,
	description?: string,
): void {
	const stats = readStats(skillsDir);
	const now = new Date().toISOString();
	const entry = stats.usage[skillName];
	if (entry) {
		entry.count += 1;
		entry.lastUsed = now;
		if (description) entry.description = description;
	} else {
		stats.usage[skillName] = {
			count: 1,
			lastUsed: now,
			created: now,
			description,
		};
	}
	writeStats(skillsDir, stats);
}

function getInactiveSkills(
	skillsDir: string,
	stats: SkillStats,
): Array<{ name: string; entry: SkillUsageEntry }> {
	const now = Date.now();
	const cutoff = now - INACTIVE_DAYS * 24 * 60 * 60 * 1000;
	const inactive: Array<{ name: string; entry: SkillUsageEntry }> = [];

	if (!existsSync(skillsDir)) return inactive;
	const skillDirs = readdirSync(skillsDir).filter((f) => {
		if (f === STATS_FILENAME || f.startsWith(".disabled-")) return false;
		const fp = join(skillsDir, f);
		return statSync(fp).isDirectory();
	});

	for (const name of skillDirs) {
		const entry = stats.usage[name];
		if (!entry) {
			inactive.push({
				name,
				entry: {
					count: 0,
					lastUsed: new Date(0).toISOString(),
					created: new Date(0).toISOString(),
				},
			});
		} else if (new Date(entry.lastUsed).getTime() < cutoff) {
			inactive.push({ name, entry });
		}
	}

	inactive.sort(
		(a, b) =>
			new Date(a.entry.lastUsed).getTime() - new Date(b.entry.lastUsed).getTime(),
	);

	return inactive;
}

function formatDaysAgo(isoDate: string): string {
	const diff = Date.now() - new Date(isoDate).getTime();
	const days = Math.floor(diff / (1000 * 60 * 60 * 24));
	if (days === 0) return "today";
	if (days === 1) return "1 day ago";
	return `${days} days ago`;
}

function parseFrontmatter(text: string): {
	name?: string;
	description?: string;
	raw: string;
} {
	const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) return { raw: text };
	const fm: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const k = line.slice(0, idx).trim().toLowerCase();
		fm[k] = line.slice(idx + 1).trim();
	}
	return { name: fm.name, description: fm.description, raw: m[2] };
}

/**
 * Escape a skill description so it is safe as a YAML frontmatter scalar.
 * A bare description containing a colon followed by a space (or starting on
 * special YAML indicators) would be parsed as a nested mapping and break the
 * frontmatter, producing a "Nested mappings are not allowed" warning at pi
 * startup. Wrap it in double quotes (escaping backslashes and quotes) when any
 * such character is present, so descriptions freely use "Covers:", colons, #,
 * quotes, curly braces, etc.
 */
function yamlSafeScalar(value: string, forceQuote: boolean): string {
	// Characters that force double-quoting in a plain YAML scalar:
	//   ": " (colon + space), leading indicator chars, or structural symbols.
	const needsQuote =
		forceQuote ||
		/[:]\s/.test(value) ||
		/^[-?:,[\]{}#&*!|>'"%@`]/u.test(value) ||
		/[[\]{}&*!|'"%@`]/.test(value);
	if (!needsQuote) return value.trim();
	const escaped = value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	// Also guard control characters that are invalid inside a double-quoted scalar.
	const sanitized = escaped.replace(
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
		" ",
	);
	return `"${sanitized}"`;
}

function buildSkillMd(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${yamlSafeScalar(description, false)}\n---\n\n${body.trim()}\n`;
}

function validateName(name: string): string | null {
	if (!name || name.length > 64) return "Name must be 1-64 characters";
	if (!/^[a-z0-9-]+$/.test(name))
		return "Name must be lowercase letters, digits, hyphen only";
	if (name.startsWith("-") || name.endsWith("-"))
		return "Name must not start or end with hyphen";
	if (name.includes("--")) return "Name must not contain consecutive hyphens";
	return null;
}

function listSkills(skillsDir: string) {
	if (!existsSync(skillsDir)) {
		return {
			content: [
				{
					type: "text" as const,
					text: "No skills directory found. Skills will be created in: " + skillsDir,
				},
			],
			details: {},
		};
	}
	const entries = readdirSync(skillsDir).filter((f) => {
		const fp = join(skillsDir, f);
		return (
			statSync(fp).isDirectory() &&
			!f.startsWith(".disabled-") &&
			f !== STATS_FILENAME
		);
	});
	const list = entries.map((dir) => {
		const fp = join(skillsDir, dir, "SKILL.md");
		if (existsSync(fp)) {
			const text = readFileSync(fp, "utf-8");
			const fm = parseFrontmatter(text);
			return `- **${fm.name ?? dir}**: ${fm.description ?? "(no description)"}`;
		}
		return `- ${dir}`;
	});
	return {
		content: [
			{
				type: "text" as const,
				text: `Found ${list.length} skill(s) in ${skillsDir}:\n\n${list.join("\n")}`,
			},
		],
		details: { skillDir: skillsDir, count: list.length },
	};
}

function inactiveReportLines(
	inactive: Array<{ name: string; entry: SkillUsageEntry }>,
): string[] {
	const lines: string[] = [];
	lines.push(
		"\u{200b}📊 **Skill Evolution: Inactive Skills Report**",
		"",
		`The following ${inactive.length} skill(s) have been inactive for over ${INACTIVE_DAYS} days.`,
		"Consider disabling or removing them if they're no longer needed:",
		"",
	);
	for (const { name, entry } of inactive) {
		const desc = entry.description ? ` — ${entry.description}` : "";
		const lastUsed =
			entry.lastUsed && entry.lastUsed !== new Date(0).toISOString()
				? ` (last used ${formatDaysAgo(entry.lastUsed)})`
				: " (never used in recorded stats)";
		lines.push(`- **${name}**${desc}${lastUsed}`);
	}
	lines.push(
		"",
		"To disable a skill, use `/skill-evolution disable <name>` or remove its directory.",
		"To re-enable: `/skill-evolution enable <name>`",
		`To turn off these reminders: \`/skill-evolution reminder off\``,
		`To check manually: \`/skill-evolution inactive\` or \`/skill-evolution reminder check\``,
	);
	return lines;
}

function buildReminderText(enabled: boolean, lastCheck: string | null): string {
	const status = enabled ? "✅ ON" : "🛑 OFF";
	const check = lastCheck
		? `Last check: ${new Date(lastCheck).toLocaleString()}`
		: "No check performed yet";
	return `Reminder: ${status} | ${check}`;
}

function buildStatsReport(skillsDir: string, stats: SkillStats): string[] {
	const allSkillNames = existsSync(skillsDir)
		? readdirSync(skillsDir).filter((f) => {
				if (
					f === STATS_FILENAME ||
					f.startsWith(".disabled-") ||
					!statSync(join(skillsDir, f)).isDirectory()
				)
					return false;
				return true;
			})
		: [];

	const lines: string[] = [
		"📊 **Skill Usage Statistics**",
		"",
		`Total skills on disk: ${allSkillNames.length}`,
		`Tracked in stats: ${Object.keys(stats.usage).length}`,
		`Reminder: ${stats.reminderEnabled ? "✅ ON" : "🛑 OFF"}`,
		`Last reminder check: ${stats.lastReminderCheck ? new Date(stats.lastReminderCheck).toLocaleString() : "never"}`,
		"",
		"--- Per-Skill Usage ---",
	];

	const allNames = new Set([...allSkillNames, ...Object.keys(stats.usage)]);
	const sorted = [...allNames].sort();
	for (const name of sorted) {
		const entry = stats.usage[name];
		const onDisk = allSkillNames.includes(name);
		if (entry) {
			const desc = entry.description ? ` — ${entry.description}` : "";
			lines.push(
				`- **${name}**${desc}: ${entry.count} use(s), last ${formatDaysAgo(entry.lastUsed)}${onDisk ? "" : " (⚠️ deleted from disk)"}`,
			);
		} else {
			lines.push(`- **${name}**: (no stats tracked yet)`);
		}
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	const SKILLS_DIR =
		process.env.PI_SKILL_EVOLUTION_DIR ??
		join(process.env.HOME ?? "/root", ".pi", "agent", "skills");

	// ─── System prompt injection ───────────────────────────────────────

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.getSystemPrompt().includes(SKILL_GUIDANCE)) return;
		return { systemPrompt: ctx.getSystemPrompt() + SKILL_GUIDANCE };
	});

	// ─── Post-turn review loop ─────────────────────────────────────────

	let reviewCooldown = 0;

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle()) return;
		reviewCooldown += 1;
		// Keep the review cadence moderate: 10 settled turns by default.
		// Too frequent (3) floods the conversation; too sparse (25+) risks
		// missing the moment before context is lost. Use /skill-evolution
		// review now for on-demand triggers.
		if (reviewCooldown % 10 !== 0) return;

		// ── Auto review (timed cadence) ──
		pi.sendUserMessage(
			`\u{200b}⚡ [${new Date().toISOString().slice(0, 19).replace("T", " ")}] Consider saving noteworthy workflows as skills via skill_manage. If nothing noteworthy, reply "no skill update needed".`,
			{ deliverAs: "followUp" },
		);
	});

	// ─── Weekly inactive-skill reminder (on session_start) ─────────────

	pi.on("session_start", (_event, _ctx) => {
		const stats = readStats(SKILLS_DIR);
		if (!stats.reminderEnabled) return;

		const now = Date.now();
		const lastCheck = stats.lastReminderCheck
			? new Date(stats.lastReminderCheck).getTime()
			: 0;

		if (lastCheck > 0 && now - lastCheck < REMINDER_INTERVAL_MS) return;

		const inactive = getInactiveSkills(SKILLS_DIR, stats);
		if (inactive.length === 0) {
			stats.lastReminderCheck = new Date().toISOString();
			writeStats(SKILLS_DIR, stats);
			return;
		}

		const lines = inactiveReportLines(inactive);
		stats.lastReminderCheck = new Date().toISOString();
		writeStats(SKILLS_DIR, stats);
		pi.sendUserMessage(lines.join("\n"), { deliverAs: "followUp" });
	});

	// ─── skill_manage tool ─────────────────────────────────────────────

	pi.registerTool({
		name: "skill_manage",
		label: "Skill Manager",
		description:
			"Create, edit, patch, delete, list, or inspect agent skills. " +
			"Use after completing complex tasks, fixing errors, or discovering new workflows. " +
			"Skills are SKILL.md files stored under the agent skills directory. " +
			'Use "patch" for small surgical edits, "edit" for full rewrites, "create" for new skills.',
		parameters: Type.Object({
			operation: Type.Enum({
				create: "create",
				edit: "edit",
				patch: "patch",
				delete: "delete",
				list: "list",
				inspect: "inspect",
			}),
			skillName: Type.String({
				description: "Skill name (lowercase, hyphen-separated, max 64 chars).",
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Skill description for create/edit. Must be specific: what it does AND when to use it.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description:
						'Full body content for create/edit (without frontmatter). For "inspect", the key section to show.',
				}),
			),
			find: Type.Optional(
				Type.String({
					description:
						'For "patch": exact text to find (case-sensitive). Use only a small, unique snippet.',
				}),
			),
			replace: Type.Optional(
				Type.String({
					description: 'For "patch": replacement text.',
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { operation, skillName } = params;

			if (operation === "list") {
				const result = listSkills(SKILLS_DIR);
				recordSkillUsage(SKILLS_DIR, "__list__", "list");
				return result;
			}

			const err = validateName(skillName);
			if (err)
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid skill name "${skillName}": ${err}`,
						},
					],
					isError: true,
					details: {},
				};

			const skillDir = join(SKILLS_DIR, skillName);
			const skillPath = join(skillDir, "SKILL.md");

			if (operation === "inspect") {
				if (!existsSync(skillPath)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Skill "${skillName}" not found at ${skillPath}`,
							},
						],
						isError: true,
						details: {},
					};
				}
				const text = readFileSync(skillPath, "utf-8");
				recordSkillUsage(SKILLS_DIR, skillName, "inspect");
				if (params.content) {
					const section = text.includes(params.content)
						? params.content
						: text.slice(0, 2000);
					return {
						content: [{ type: "text" as const, text: section }],
						details: {},
					};
				}
				return { content: [{ type: "text" as const, text }], details: {} };
			}

			if (operation === "create") {
				const desc = params.description;
				if (!desc)
					return {
						content: [
							{
								type: "text" as const,
								text: 'Missing "description" for create',
							},
						],
						isError: true,
						details: {},
					};
				if (existsSync(skillPath))
					return {
						content: [
							{
								type: "text" as const,
								text: `Skill "${skillName}" already exists at ${skillPath}. Use "edit" or "patch" to update.`,
							},
						],
						isError: true,
						details: {},
					};

				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					skillPath,
					buildSkillMd(skillName, desc, params.content ?? `# ${skillName}`),
					"utf-8",
				);
				recordSkillUsage(SKILLS_DIR, skillName, "create", desc);
				return {
					content: [
						{
							type: "text" as const,
							text: `Created skill "${skillName}" at ${skillPath}`,
						},
					],
					details: { path: skillPath },
				};
			}

			if (operation === "edit") {
				if (!existsSync(skillPath))
					return {
						content: [
							{
								type: "text" as const,
								text: `Skill "${skillName}" not found. Use "create" first.`,
							},
						],
						isError: true,
						details: {},
					};
				const desc = params.description;
				if (!desc)
					return {
						content: [
							{ type: "text" as const, text: 'Missing "description" for edit' },
						],
						isError: true,
						details: {},
					};
				writeFileSync(
					skillPath,
					buildSkillMd(skillName, desc, params.content ?? ""),
					"utf-8",
				);
				recordSkillUsage(SKILLS_DIR, skillName, "edit", desc);
				return {
					content: [
						{
							type: "text" as const,
							text: `Updated skill "${skillName}" at ${skillPath}`,
						},
					],
					details: { path: skillPath },
				};
			}

			if (operation === "patch") {
				if (!existsSync(skillPath))
					return {
						content: [
							{
								type: "text" as const,
								text: `Skill "${skillName}" not found. Use "create" first.`,
							},
						],
						isError: true,
						details: {},
					};
				if (!params.find)
					return {
						content: [{ type: "text" as const, text: 'Missing "find" for patch' }],
						isError: true,
						details: {},
					};
				const text = readFileSync(skillPath, "utf-8");
				if (!text.includes(params.find))
					return {
						content: [
							{
								type: "text" as const,
								text: `Patch failed: "${params.find.slice(0, 60)}..." not found in ${skillPath}`,
							},
						],
						isError: true,
						details: {},
					};
				const count = (
					text.match(
						new RegExp(params.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
					) ?? []
				).length;
				if (count > 1)
					return {
						content: [
							{
								type: "text" as const,
								text: `Patch ambiguous: "${params.find.slice(0, 60)}..." found ${count} times. Use a longer, unique snippet.`,
							},
						],
						isError: true,
						details: {},
					};
				const newText = text.replace(params.find, params.replace ?? "");
				writeFileSync(skillPath, newText, "utf-8");
				recordSkillUsage(SKILLS_DIR, skillName, "patch");
				return {
					content: [
						{
							type: "text" as const,
							text: `Patched skill "${skillName}" at ${skillPath}`,
						},
					],
					details: { path: skillPath },
				};
			}

			if (operation === "delete") {
				if (!existsSync(skillPath))
					return {
						content: [
							{
								type: "text" as const,
								text: `Skill "${skillName}" not found.`,
							},
						],
						isError: true,
						details: {},
					};
				unlinkSync(skillPath);
				const dirContents = readdirSync(skillDir);
				if (dirContents.length === 0) {
					mkdirSync(`${skillDir}/tmp`, { recursive: true });
					unlinkSync(`${skillDir}/tmp`);
				}
				recordSkillUsage(SKILLS_DIR, skillName, "delete");
				return {
					content: [{ type: "text" as const, text: `Deleted skill "${skillName}"` }],
					details: {},
				};
			}

			return {
				content: [
					{ type: "text" as const, text: `Unknown operation: ${operation}` },
				],
				isError: true,
				details: {},
			};
		},
	});

	// ─── /skill-evolution command ──────────────────────────────────────

	pi.registerCommand("skill-evolution", {
		description:
			"Skill evolution management. Subcommands: reminder on|off|status|check, inactive, stats, disable/enable <name>",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				"reminder on",
				"reminder off",
				"reminder status",
				"reminder check",
				"inactive",
				"stats",
				"review now",
				"disable ",
				"enable ",
			];
			const filtered = subcommands
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c }));
			if (filtered.length > 0) return filtered;
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// ── review subcommand ──

			if (trimmed === "review now") {
				const now = new Date().toISOString().slice(0, 19).replace("T", " ");
				const inactive = getInactiveSkills(SKILLS_DIR, readStats(SKILLS_DIR));
				const hint =
					inactive.length > 0
						? ` (${inactive.length} inactive skill(s) — review them too)`
						: "";
				pi.sendUserMessage(
					`\u{200b}⚡ [${now}] Manual review triggered${hint}. Consider saving noteworthy workflows as skills via skill_manage. If nothing noteworthy, reply "no skill update needed".`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			// ── reminder subcommands ──

			if (trimmed === "reminder on") {
				const stats = readStats(SKILLS_DIR);
				stats.reminderEnabled = true;
				writeStats(SKILLS_DIR, stats);
				ctx.ui.notify(
					"✅ Weekly inactive-skill reminder enabled (persistent)",
					"info",
				);
				return;
			}

			if (trimmed === "reminder off") {
				const stats = readStats(SKILLS_DIR);
				stats.reminderEnabled = false;
				writeStats(SKILLS_DIR, stats);
				ctx.ui.notify(
					"🛑 Weekly inactive-skill reminder disabled (persistent)",
					"info",
				);
				return;
			}

			if (trimmed === "reminder status") {
				const stats = readStats(SKILLS_DIR);
				ctx.ui.notify(
					buildReminderText(stats.reminderEnabled, stats.lastReminderCheck),
					"info",
				);
				return;
			}

			if (trimmed === "reminder check") {
				const stats = readStats(SKILLS_DIR);
				const inactive = getInactiveSkills(SKILLS_DIR, stats);
				stats.lastReminderCheck = new Date().toISOString();
				writeStats(SKILLS_DIR, stats);

				if (inactive.length === 0) {
					pi.sendUserMessage(
						"\u{200b}✅ **Weekly Inactive Skills Check**: All skills are active (used within 30 days).",
						{ deliverAs: "followUp" },
					);
				} else {
					pi.sendUserMessage(inactiveReportLines(inactive).join("\n"), {
						deliverAs: "followUp",
					});
				}
				return;
			}

			// ── inactive subcommand ──

			if (trimmed === "inactive") {
				const stats = readStats(SKILLS_DIR);
				const inactive = getInactiveSkills(SKILLS_DIR, stats);
				if (inactive.length === 0) {
					ctx.ui.notify("✅ All skills are active (used within 30 days)", "info");
					return;
				}
				ctx.ui.notify(inactiveReportLines(inactive).join("\n"), "info");
				return;
			}

			// ── stats subcommand ──

			if (trimmed === "stats") {
				const stats = readStats(SKILLS_DIR);
				ctx.ui.notify(buildStatsReport(SKILLS_DIR, stats).join("\n"), "info");
				return;
			}

			// ── disable subcommand ──

			if (trimmed.startsWith("disable ")) {
				const targetName = trimmed.slice(8).trim();
				if (!targetName) {
					ctx.ui.notify("Usage: /skill-evolution disable <skill-name>", "error");
					return;
				}
				const targetDir = join(SKILLS_DIR, targetName);
				if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
					ctx.ui.notify(`Skill "${targetName}" not found`, "error");
					return;
				}
				const disabledDir = join(SKILLS_DIR, `.disabled-${targetName}`);
				if (existsSync(disabledDir)) {
					ctx.ui.notify(
						`Skill "${targetName}" is already disabled (or .disabled-${targetName} exists)`,
						"error",
					);
					return;
				}
				renameSync(targetDir, disabledDir);
				ctx.ui.notify(
					`🚫 Disabled skill "${targetName}" (renamed to .disabled-${targetName})`,
					"info",
				);
				return;
			}

			// ── enable subcommand ──

			if (trimmed.startsWith("enable ")) {
				const targetName = trimmed.slice(7).trim();
				if (!targetName) {
					ctx.ui.notify("Usage: /skill-evolution enable <skill-name>", "error");
					return;
				}
				const disabledDir = join(SKILLS_DIR, `.disabled-${targetName}`);
				if (!existsSync(disabledDir)) {
					ctx.ui.notify(
						`Disabled skill "${targetName}" not found. Maybe it's already enabled?`,
						"error",
					);
					return;
				}
				const targetDir = join(SKILLS_DIR, targetName);
				renameSync(disabledDir, targetDir);
				ctx.ui.notify(`✅ Re-enabled skill "${targetName}"`, "info");
				return;
			}

			// ── default: show help ──

			ctx.ui.notify(
				"📋 **Skill Evolution Commands**\n\n" +
					"/skill-evolution review now        — Trigger a skill review session now\n" +
					"/skill-evolution reminder on      — Enable weekly inactive-skill reminder\n" +
					"/skill-evolution reminder off     — Disable weekly reminder\n" +
					"/skill-evolution reminder status  — Show reminder status\n" +
					"/skill-evolution reminder check   — Manually check inactive skills now\n" +
					"/skill-evolution inactive         — List inactive skills\n" +
					"/skill-evolution stats            — Show usage statistics for all skills\n" +
					"/skill-evolution disable <name>   — Disable a skill (rename to .disabled-<name>)\n" +
					"/skill-evolution enable <name>    — Re-enable a disabled skill",
				"info",
			);
		},
	});
}
