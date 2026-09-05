import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { splitSkillMd } from "./skill-md-codec.ts";
import { ActivityStore, type ActivityPaths } from "./activity-store.ts";
import { createSkillMutations, type SkillMutations } from "./skill-mutations.ts";
import { createReviewPipeline, serializeRun as serializePipelineRun } from "./review-pipeline.ts";
import { createProposalLedger } from "./proposal-ledger.ts";
import {
	discoverSkills,
	fileHash,
	requireSkillName,
	resolveSkill,
	safePackagePath,
	skillDirectory,
	type Scope,
	validateSkillName,
} from "./skill-package.ts";

const REVIEW_GUARDRAIL =
	"\n\n## Skill Evolution\nDo not create or fully rewrite skills directly. Skill creation, frontmatter changes, package-file changes, and disabling require a skill-evolution proposal.\n";
const DEFAULT_REVIEW_INTERVAL = 10;
const DEFAULT_MAX_PROPOSALS = 3;
const DEFAULT_INACTIVE_DAYS = 30;
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
const PROPOSAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_ENTRY_TYPE = "skill-evolution-run-v2";
const REVIEW_STATE_ENTRY_TYPE = "skill-evolution-review-state-v2";

interface ReviewConfig {
	reviewModel?: string;
	reviewInterval: number;
	maxProposals: number;
	inactiveDays: number;
}

type ProposalStatus = "pending" | "applied" | "rejected" | "stale";

type ProposalOperation =
	| {
			type: "create";
			skillName: string;
			description: string;
			content: string;
			beforeHash?: string | null;
	  }
	| {
			type: "edit";
			skillName: string;
			description?: string;
			content: string;
			beforeHash?: string | null;
	  }
	| {
			type: "patch";
			skillName: string;
			path: string;
			find: string;
			replace: string;
			beforeHash?: string | null;
	  }
	| {
			type: "write";
			skillName: string;
			path: string;
			content: string;
			beforeHash?: string | null;
	  }
	| {
			type: "disable";
			skillName: string;
			beforeHash?: string | null;
	  };

interface Proposal {
	version: 1;
	id: string;
	title: string;
	rationale: string;
	scope: Scope;
	status: ProposalStatus;
	createdAt: string;
	updatedAt: string;
	operations: ProposalOperation[];
}

interface ReviewerDraft {
	title: string;
	rationale: string;
	scope: Scope;
	operations: ProposalOperation[];
}

interface RunRecord {
	index: number;
	timestamp: string;
	text: string;
}

type Paths = ActivityPaths;

function defaultConfig(): ReviewConfig {
	return {
		reviewInterval: DEFAULT_REVIEW_INTERVAL,
		maxProposals: DEFAULT_MAX_PROPOSALS,
		inactiveDays: DEFAULT_INACTIVE_DAYS,
	};
}

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeTextAtomic(path: string, content: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, content, { encoding: "utf8", mode });
	renameSync(temporary, path);
}

function writeJsonAtomic(path: string, value: unknown): void {
	writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function queuedWriteJson(path: string, value: unknown): Promise<void> {
	await withFileMutationQueue(path, async () => writeJsonAtomic(path, value));
}

function getPaths(cwd: string): Paths {
	const home = process.env.HOME ?? "/root";
	const agentDir = join(home, ".pi", "agent");
	return {
		globalSkills: process.env.PI_SKILL_EVOLUTION_DIR ?? join(agentDir, "skills"),
		projectSkills: join(cwd, ".agents", "skills"),
		globalState: join(agentDir, "skill-evolution"),
		projectState: join(cwd, CONFIG_DIR_NAME, "skill-evolution"),
	};
}

function stateDir(paths: Paths, scope: Scope): string {
	return scope === "global" ? paths.globalState : paths.projectState;
}

function skillsDir(paths: Paths, scope: Scope): string {
	return scope === "global" ? paths.globalSkills : paths.projectSkills;
}

function proposalDir(paths: Paths, scope: Scope): string {
	return join(stateDir(paths, scope), "proposals");
}

function readConfig(paths: Paths, includeProject: boolean): ReviewConfig {
	const globalConfig = readJson<Partial<ReviewConfig>>(join(paths.globalState, "config.json"), {});
	const projectConfig = includeProject
		? readJson<Partial<ReviewConfig>>(join(paths.projectState, "config.json"), {})
		: {};
	const merged = { ...defaultConfig(), ...globalConfig, ...projectConfig };
	return {
		reviewModel: merged.reviewModel,
		reviewInterval: Math.max(1, Math.floor(merged.reviewInterval ?? DEFAULT_REVIEW_INTERVAL)),
		maxProposals: Math.max(1, Math.min(3, Math.floor(merged.maxProposals ?? DEFAULT_MAX_PROPOSALS))),
		inactiveDays: Math.max(1, Math.floor(merged.inactiveDays ?? DEFAULT_INACTIVE_DAYS)),
	};
}

function truncateText(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = text.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return `${result}\n\n[Output truncated at ${maxBytes} bytes.]`;
}

function operationPath(paths: Paths, scope: Scope, operation: ProposalOperation): string {
	const root = skillDirectory(skillsDir(paths, scope), operation.skillName);
	if (operation.type === "create" || operation.type === "edit" || operation.type === "disable") {
		return join(root, "SKILL.md");
	}
	return safePackagePath(root, operation.path);
}

function withQueues<T>(paths: string[], work: () => Promise<T>, index = 0): Promise<T> {
	const unique = [...new Set(paths.map((path) => resolve(path)))].sort();
	const acquire = (position: number): Promise<T> => {
		if (position >= unique.length) return work();
		return withFileMutationQueue(unique[position], () => acquire(position + 1));
	};
	return acquire(index);
}

function readProposal(path: string): Proposal {
	const proposal = readJson<Proposal | null>(path, null);
	if (!proposal || proposal.version !== 1 || !proposal.id) throw new Error(`Invalid proposal file: ${path}`);
	return proposal;
}

function findProposal(paths: Paths, id: string, includeProject: boolean): { path: string; proposal: Proposal } {
	const matches: Array<{ path: string; proposal: Proposal }> = [];
	const scopes: Scope[] = includeProject ? ["global", "project"] : ["global"];
	for (const scope of scopes) {
		const path = join(proposalDir(paths, scope), `${id}.json`);
		if (existsSync(path)) matches.push({ path, proposal: readProposal(path) });
	}
	if (matches.length === 0) throw new Error(`Proposal "${id}" was not found`);
	if (matches.length > 1) throw new Error(`Proposal ID "${id}" is ambiguous`);
	return matches[0];
}

function listProposals(paths: Paths, includeProject: boolean): Array<{ path: string; proposal: Proposal }> {
	const result: Array<{ path: string; proposal: Proposal }> = [];
	const scopes: Scope[] = includeProject ? ["global", "project"] : ["global"];
	for (const scope of scopes) {
		const dir = proposalDir(paths, scope);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
			const path = join(dir, name);
			try {
				result.push({ path, proposal: readProposal(path) });
			} catch {
				// Ignore malformed proposal files in list output.
			}
		}
	}
	return result.sort((a, b) => b.proposal.createdAt.localeCompare(a.proposal.createdAt));
}

function proposalSummary(proposal: Proposal): string {
	const operations = proposal.operations
		.map((operation) => {
			const path = operation.type === "patch" || operation.type === "write" ? `/${operation.path}` : "";
			return `  - ${operation.type} ${operation.skillName}${path}`;
		})
		.join("\n");
	return `# ${proposal.title}\n\nID: ${proposal.id}\nStatus: ${proposal.status}\nScope: ${proposal.scope}\nCreated: ${proposal.createdAt}\n\n${proposal.rationale}\n\nOperations:\n${operations}`;
}

function attachHashes(paths: Paths, draft: ReviewerDraft): ProposalOperation[] {
	return draft.operations.map((operation) => ({
		...operation,
		beforeHash: fileHash(operationPath(paths, draft.scope, operation)),
	}));
}

async function saveProposal(paths: Paths, draft: ReviewerDraft, includeProject: boolean): Promise<Proposal> {
	if (draft.scope !== "global" && draft.scope !== "project") throw new Error("Proposal has invalid scope");
	if (!draft.operations?.length) throw new Error("Proposal has no operations");
	for (const operation of draft.operations) requireSkillName(operation.skillName);

	const duplicate = listProposals(paths, includeProject).find(
		({ proposal }) =>
			proposal.status === "pending" &&
			proposal.scope === draft.scope &&
			JSON.stringify(proposal.operations) === JSON.stringify(attachHashes(paths, draft)),
	);
	if (duplicate) return duplicate.proposal;

	const now = new Date().toISOString();
	const proposal: Proposal = {
		version: 1,
		id: randomUUID(),
		title: draft.title,
		rationale: draft.rationale,
		scope: draft.scope,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		operations: attachHashes(paths, draft),
	};
	const path = join(proposalDir(paths, proposal.scope), `${proposal.id}.json`);
	await queuedWriteJson(path, proposal);
	return proposal;
}

function assertProposalFresh(paths: Paths, proposal: Proposal): void {
	for (const operation of proposal.operations) {
		const current = fileHash(operationPath(paths, proposal.scope, operation));
		if (current !== (operation.beforeHash ?? null)) {
			throw new Error(`Proposal is stale for ${operation.skillName} (${operation.type})`);
		}
	}
}

function validateOperationMinimal(
	paths: Paths,
	scope: Scope,
	operation: ProposalOperation,
	createdSkills: Set<string>,
	includeProject: boolean,
): void {
	const error = validateSkillName(operation.skillName);
	if (error) throw new Error(error);
	const skillMd = join(skillDirectory(skillsDir(paths, scope), operation.skillName), "SKILL.md");
	if (operation.type === "create") {
		if (!operation.description.trim()) throw new Error("Create requires a description");
		if (!operation.content.trim()) throw new Error("Create requires a non-empty body");
		const collision = discoverSkills(paths).find(
			(skill) => skill.name === operation.skillName && (includeProject || skill.scope === "global"),
		);
		if (collision) throw new Error(`Skill name "${operation.skillName}" already exists in ${collision.scope} scope`);
		return;
	}
	if (!existsSync(skillMd) && !(operation.type === "write" && createdSkills.has(operation.skillName))) {
		throw new Error(`Skill "${operation.skillName}" has no SKILL.md`);
	}
	if (operation.type === "edit" && !operation.content.trim()) throw new Error("Edit requires a non-empty body");
	if (operation.type === "patch" && !operation.find) throw new Error("Patch requires non-empty find text");
}

async function applyProposal(
	_paths: Paths,
	proposal: Proposal,
	_onOperation?: (operation: ProposalOperation, index: number) => void | Promise<void>,
): Promise<void> {
	const ledger = createProposalLedger(_paths, { onOperation: _onOperation });
	await ledger.apply(proposal);
}

async function safeBodyPatch(
	mutations: SkillMutations,
	scope: Scope,
	skillName: string,
	find: string,
	replace: string,
): Promise<string> {
	return mutations.bodyPatch(scope, skillName, find, replace);
}

function loadAuthoringReference(paths: Paths): string {
	const candidates = [
		join(paths.globalSkills, "skill-authoring", "SKILL.md"),
		join(paths.projectSkills, "skill-authoring", "SKILL.md"),
	];
	for (const path of candidates) {
		if (existsSync(path)) return truncateText(readFileSync(path, "utf8"), 20 * 1024);
	}
	return [
		"Write ordered steps with checkable completion criteria.",
		"Preserve one source of truth and existing frontmatter fields.",
		"Prefer patching an existing skill over creating a duplicate.",
		"Change description only when capability, trigger branches, or invocation mode changes.",
		"Move branch-only reference behind a relative context pointer.",
	].join("\\n");
}

function extractTextResponse(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function selectReviewModel(ctx: ExtensionContext, config: ReviewConfig) {
	if (config.reviewModel) {
		const slash = config.reviewModel.indexOf("/");
		if (slash > 0) {
			const model = ctx.modelRegistry.find(config.reviewModel.slice(0, slash), config.reviewModel.slice(slash + 1));
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
		}
	}
	return ctx.model;
}

function createReviewSignal(parent: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 120_000);
	const abort = () => controller.abort();
	parent.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parent.removeEventListener("abort", abort);
		},
	};
}

async function completeJson(
	ctx: ExtensionContext,
	config: ReviewConfig,
	systemPrompt: string,
	prompt: string,
	signal: AbortSignal,
): Promise<string> {
	const model = selectReviewModel(ctx, config);
	if (!model) throw new Error("No reviewer model is available");
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			maxTokens: 4096,
			signal,
			cacheRetention: "none",
			sessionId: randomUUID(),
		},
	);
	return extractTextResponse(response);
}

function cleanOldProposals(paths: Paths, includeProject: boolean): void {
	const cutoff = Date.now() - PROPOSAL_RETENTION_MS;
	for (const { path, proposal } of listProposals(paths, includeProject)) {
		if (proposal.status === "pending") continue;
		if (new Date(proposal.updatedAt).getTime() < cutoff) rmSync(path, { force: true });
	}
}

function scopeFrom(value: string | undefined): Scope | undefined {
	if (value === undefined) return undefined;
	if (value !== "global" && value !== "project") throw new Error('Scope must be "global" or "project"');
	return value;
}

function findSection(text: string, query: string): string {
	const index = text.indexOf(query);
	if (index < 0) return truncateText(text.slice(0, 2000));
	const nextHeading = text.indexOf("\n#", index + query.length);
	return truncateText(text.slice(index, nextHeading < 0 ? undefined : nextHeading));
}

const SkillManageParameters = Type.Object({
	operation: StringEnum(["create", "edit", "patch", "delete", "list", "inspect", "write_file"] as const),
	skillName: Type.Optional(Type.String({ description: "Skill name" })),
	scope: Type.Optional(StringEnum(["global", "project"] as const)),
	proposalId: Type.Optional(Type.String({ description: "Approved proposal ID for protected writes" })),
	description: Type.Optional(Type.String()),
	content: Type.Optional(Type.String({ description: "Body, file content, or inspect section query" })),
	path: Type.Optional(Type.String({ description: "Relative package path for write_file" })),
	find: Type.Optional(Type.String({ description: "Unique exact text for patch" })),
	replace: Type.Optional(Type.String({ description: "Replacement text for patch" })),
});

export default function skillEvolution(pi: ExtensionAPI) {
	let paths = getPaths(process.cwd());
	let activity = new ActivityStore(paths);
	let mutations: SkillMutations = createSkillMutations(paths, activity);
	let config = readConfig(paths, false);
	let pendingAgentMessages: unknown[] = [];
	let pendingRuns: RunRecord[] = [];
	let nextRunIndex = 1;
	let reviewedThrough = 0;
	let reviewRunning = false;
	const reviewQueue: Array<{ runs: RunRecord[]; ctx: ExtensionContext }> = [];
	let sessionAbort = new AbortController();

	function restoreReviewState(ctx: ExtensionContext): void {
		pendingRuns = [];
		nextRunIndex = 1;
		reviewedThrough = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === RUN_ENTRY_TYPE) {
				const record = entry.data as RunRecord;
				if (record && typeof record.index === "number" && typeof record.text === "string") {
					pendingRuns.push(record);
					nextRunIndex = Math.max(nextRunIndex, record.index + 1);
				}
			} else if (entry.customType === REVIEW_STATE_ENTRY_TYPE) {
				const state = entry.data as { reviewedThrough?: number };
				reviewedThrough = Math.max(reviewedThrough, state.reviewedThrough ?? 0);
			}
		}
		pendingRuns = pendingRuns.filter((record) => record.index > reviewedThrough).sort((a, b) => a.index - b.index);
	}

	async function logReviewError(error: unknown): Promise<void> {
		const path = join(paths.projectState, "review-errors.log");
		await withFileMutationQueue(path, async () => {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${new Date().toISOString()} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		});
	}

	async function drainReviewQueue(): Promise<void> {
		if (reviewRunning) return;
		reviewRunning = true;
		try {
			while (reviewQueue.length > 0 && !sessionAbort.signal.aborted) {
				const item = reviewQueue.shift()!;
				const combined = createReviewSignal(sessionAbort.signal);
				try {
					const pipeline = createReviewPipeline({
						paths,
						config,
						trustedProject: item.ctx.isProjectTrusted(),
						authoringReference: loadAuthoringReference(paths),
						model: ({ model, systemPrompt, prompt, signal }) => {
							const selected = model ? { ...config, reviewModel: model } : config;
							return completeJson(item.ctx, selected, systemPrompt, prompt, signal);
						},
					});
					const proposals = await pipeline.review(item.runs, combined.signal);
					if (proposals.length > 0 && item.ctx.hasUI) {
						item.ctx.ui.notify(
							`Skill evolution created ${proposals.length} proposal(s). Use /skill-evolution proposal list.`,
							"info",
						);
					}
				} catch (error) {
					if (!sessionAbort.signal.aborted) await logReviewError(error);
				} finally {
					combined.cleanup();
					const last = item.runs[item.runs.length - 1]?.index;
					if (last && !sessionAbort.signal.aborted) {
						reviewedThrough = Math.max(reviewedThrough, last);
						pi.appendEntry(REVIEW_STATE_ENTRY_TYPE, { reviewedThrough });
					}
				}
			}
		} finally {
			reviewRunning = false;
		}
	}

	function queueReview(runs: RunRecord[], ctx: ExtensionContext): void {
		if (runs.length === 0) return;
		reviewQueue.push({ runs, ctx });
		void drainReviewQueue();
	}

	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(REVIEW_GUARDRAIL)) return;
		return { systemPrompt: event.systemPrompt + REVIEW_GUARDRAIL };
	});

	pi.on("session_start", async (_event, ctx) => {
		paths = getPaths(ctx.cwd);
		const projectTrusted = ctx.isProjectTrusted();
		config = readConfig(paths, projectTrusted);
		sessionAbort = new AbortController();
		activity = new ActivityStore(paths);
		mutations = createSkillMutations(paths, activity);
		pendingAgentMessages = [];
		reviewQueue.length = 0;
		reviewRunning = false;
		restoreReviewState(ctx);
		cleanOldProposals(paths, projectTrusted);

		mutations.removeLegacyStats();

		const enabledScopes: Scope[] = projectTrusted ? ["global", "project"] : ["global"];
		const initialReminderChoice = enabledScopes.some(
			(scope) => activity.readStats(scope).reminderEnabled === null,
		)
			? ctx.mode === "tui"
				? await ctx.ui.confirm("Inactive skill reminders", "Enable weekly inactive-skill reminders?")
				: false
			: undefined;
		for (const scope of enabledScopes) {
			const stats = activity.readStats(scope);
			if (stats.reminderEnabled === null) {
				stats.reminderEnabled = initialReminderChoice ?? false;
				await activity.updateStatsFile(scope, (current) => {
					current.reminderEnabled = stats.reminderEnabled;
				});
			}
			if (!stats.reminderEnabled) continue;
			const lastCheck = stats.lastReminderCheck ? new Date(stats.lastReminderCheck).getTime() : 0;
			if (lastCheck && Date.now() - lastCheck < REMINDER_INTERVAL_MS) continue;
			const inactive = activity.inactiveSkills(scope, config.inactiveDays);
			stats.lastReminderCheck = new Date().toISOString();
			await activity.updateStatsFile(scope, (current) => {
				current.lastReminderCheck = stats.lastReminderCheck;
			});
			if (inactive.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Inactive ${scope} skills: ${inactive.join(", ")}`, "info");
			}
		}
	});

	pi.on("session_shutdown", () => {
		sessionAbort.abort();
		reviewQueue.length = 0;
	});

	pi.on("agent_end", (event) => {
		pendingAgentMessages.push(...event.messages);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle()) return;
		const record: RunRecord = {
			index: nextRunIndex++,
			timestamp: new Date().toISOString(),
			text: serializePipelineRun(pendingAgentMessages),
		};
		pendingAgentMessages = [];
		pendingRuns.push(record);
		pi.appendEntry(RUN_ENTRY_TYPE, record);

		while (pendingRuns.length >= config.reviewInterval) {
			const batch = pendingRuns.splice(0, config.reviewInterval);
			queueReview(batch, ctx);
		}
	});

	pi.on("input", async (event, ctx) => {
		const match = event.text.match(/^\/skill:([a-z0-9-]+)(?:\s|$)/);
		if (!match) return { action: "continue" as const };
		try {
			const skill = resolveSkill(paths, match[1]);
			if (skill.scope === "global" || ctx.isProjectTrusted()) {
				await activity.recordActivity(skill.scope, skill.name, "explicitInvocation", skill.description);
			}
		} catch {
			// Pi will report unknown skill commands itself.
		}
		return { action: "continue" as const };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const input = event.input as { path?: string };
		if (!input.path || !/SKILL\.md$/i.test(input.path)) return;
		const requested = resolve(ctx.cwd, input.path.replace(/^@/, ""));
		const skill = discoverSkills(paths).find((candidate) => resolve(candidate.path) === requested);
		if (skill && (skill.scope === "global" || ctx.isProjectTrusted())) {
			await activity.recordActivity(skill.scope, skill.name, "skillLoad", skill.description);
		}
	});

	pi.registerTool({
		name: "skill_manage",
		label: "Skill Manager",
		description:
			"Inspect and list skills, apply a unique body-only SKILL.md patch, or execute an approved skill-evolution proposal. Protected writes require proposalId.",
		parameters: SkillManageParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const operation = params.operation;
			if (operation === "list") {
				const lines = discoverSkills(paths)
					.filter((skill) => skill.scope === "global" || ctx.isProjectTrusted())
					.map(
					(skill) => `- [${skill.scope}] **${skill.name}**: ${skill.description || "(no description)"}`,
				);
				return { content: [{ type: "text" as const, text: truncateText(lines.join("\n") || "No skills found") }], details: {} };
			}

			const skillName = requireSkillName(params.skillName);
			const requestedScope = scopeFrom(params.scope);
			if (requestedScope === "project" && !ctx.isProjectTrusted()) {
				throw new Error("Project-scope skill operations require a trusted project");
			}
			if (operation === "inspect") {
				const skill = resolveSkill(paths, skillName, requestedScope);
				if (skill.scope === "project" && !ctx.isProjectTrusted()) {
					throw new Error("Inspecting a project skill requires a trusted project");
				}
				const text = readFileSync(skill.path, "utf8");
				await activity.recordActivity(skill.scope, skill.name, "management", skill.description);
				return {
					content: [{ type: "text" as const, text: params.content ? findSection(text, params.content) : truncateText(text) }],
					details: { path: skill.path, scope: skill.scope },
				};
			}

			if (operation === "patch" && !params.proposalId) {
				if (!requestedScope) throw new Error('Body-only patch requires explicit "scope"');
				if (!params.find) throw new Error('Missing "find" for patch');
				const path = await safeBodyPatch(mutations, requestedScope, skillName, params.find, params.replace ?? "");
				return { content: [{ type: "text" as const, text: `Patched ${path}` }], details: { path } };
			}

			if (!params.proposalId) throw new Error(`${operation} requires an approved proposalId`);
			const found = findProposal(paths, params.proposalId, ctx.isProjectTrusted());
			if (requestedScope && requestedScope !== found.proposal.scope) {
				throw new Error(`Proposal scope is ${found.proposal.scope}, not ${requestedScope}`);
			}
			const expectedType = operation === "write_file" ? "write" : operation === "delete" ? "disable" : operation;
			if (!found.proposal.operations.some((item) => item.skillName === skillName && item.type === expectedType)) {
				throw new Error(`Proposal ${params.proposalId} has no ${expectedType} operation for skill "${skillName}"`);
			}
			if (found.proposal.scope === "project" && !ctx.isProjectTrusted()) {
				throw new Error("Applying a project proposal requires a trusted project");
			}
			await applyProposal(paths, found.proposal);
			return {
				content: [{ type: "text" as const, text: `Applied proposal ${found.proposal.id}. Run /reload if discovery data changed.` }],
				details: { proposalId: found.proposal.id },
			};
		},
	});

	pi.registerCommand("skill-evolution", {
		description: "Review skill evolution proposals, statistics, reminders, and disabled skills",
		getArgumentCompletions: (prefix) => {
			const commands = [
				"review now",
				"proposal list",
				"proposal show ",
				"proposal apply ",
				"proposal reject ",
				"stats",
				"inactive",
				"reminder on",
				"reminder off",
				"reminder status",
				"disable global ",
				"disable project ",
				"enable global ",
				"enable project ",
				"purge global ",
				"purge project ",
			];
			const matches = commands.filter((command) => command.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const tokens = trimmed.split(/\s+/).filter(Boolean);

			if (trimmed === "review now") {
				const batch = pendingRuns.splice(0);
				if (batch.length === 0) {
					ctx.ui.notify("No unreviewed agent runs", "info");
					return;
				}
				queueReview(batch, ctx);
				ctx.ui.notify(`Queued review of ${batch.length} agent run(s)`, "info");
				return;
			}

			if (tokens[0] === "proposal") {
				if (tokens[1] === "list") {
					const proposals = listProposals(paths, ctx.isProjectTrusted());
					const text = proposals.length
						? proposals.map(({ proposal }) => `${proposal.id} [${proposal.status}/${proposal.scope}] ${proposal.title}`).join("\n")
						: "No proposals found";
					ctx.ui.notify(truncateText(text), "info");
					return;
				}
				if ((tokens[1] === "show" || tokens[1] === "apply" || tokens[1] === "reject") && tokens[2]) {
					const found = findProposal(paths, tokens[2], ctx.isProjectTrusted());
					if (tokens[1] === "show") {
						ctx.ui.notify(truncateText(proposalSummary(found.proposal)), "info");
						return;
					}
					if (tokens[1] === "reject") {
						if (found.proposal.status !== "pending") throw new Error(`Proposal is ${found.proposal.status}`);
						found.proposal.status = "rejected";
						found.proposal.updatedAt = new Date().toISOString();
						await queuedWriteJson(found.path, found.proposal);
						ctx.ui.notify(`Rejected proposal ${found.proposal.id}`, "info");
						return;
					}
					await applyProposal(paths, found.proposal);
					ctx.ui.notify(`Applied proposal ${found.proposal.id}. Run /reload if discovery data changed.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /skill-evolution proposal list|show|apply|reject [id]", "error");
				return;
			}

			if (trimmed === "stats" || trimmed === "inactive") {
				const lines: string[] = [];
				const scopes: Scope[] = ctx.isProjectTrusted() ? ["global", "project"] : ["global"];
				for (const scope of scopes) {
					if (trimmed === "inactive") {
						lines.push(`${scope}: ${activity.inactiveSkills(scope, config.inactiveDays).join(", ") || "none"}`);
						continue;
					}
					const stats = activity.readStats(scope);
					lines.push(`[${scope}]`);
					for (const [name, entry] of Object.entries(stats.skills).sort(([a], [b]) => a.localeCompare(b))) {
						lines.push(
							`${name}: explicit=${entry.explicitInvocationCount}, loads=${entry.skillLoadCount}, management=${entry.managementOperations}`,
						);
					}
				}
				ctx.ui.notify(truncateText(lines.join("\n")), "info");
				return;
			}

			if (tokens[0] === "reminder" && ["on", "off", "status"].includes(tokens[1])) {
				const scopes: Scope[] = ctx.isProjectTrusted() ? ["global", "project"] : ["global"];
				for (const scope of scopes) {
					const stats = activity.readStats(scope);
					if (tokens[1] === "on") stats.reminderEnabled = true;
					if (tokens[1] === "off") stats.reminderEnabled = false;
					if (tokens[1] !== "status") {
						await activity.updateStatsFile(scope, (current) => {
							current.reminderEnabled = stats.reminderEnabled;
						});
					}
				}
				const status = scopes
					.map((scope) => `${scope}=${activity.readStats(scope).reminderEnabled ? "on" : "off"}`)
					.join(", ");
				ctx.ui.notify(`Inactive reminders: ${status}`, "info");
				return;
			}

			if (["disable", "enable", "purge"].includes(tokens[0]) && tokens[1] && tokens[2]) {
				const action = tokens[0];
				const scope = scopeFrom(tokens[1])!;
				if (scope === "project" && !ctx.isProjectTrusted()) {
					throw new Error("Project-scope commands require a trusted project");
				}
				const name = requireSkillName(tokens[2]);
				if (action === "disable" || action === "enable") {
					await mutations.setEnabled(scope, name, action === "enable");
					ctx.ui.notify(`${action === "enable" ? "Enabled" : "Disabled"} ${scope} skill "${name}". Run /reload.`, "info");
					return;
				}
				const confirmed = ctx.hasUI && await ctx.ui.confirm("Purge skill package?", `Delete package "${name}" permanently?`);
				if (!await mutations.purge(scope, name, confirmed)) return;
				ctx.ui.notify(`Purged ${scope} skill "${name}". Run /reload.`, "info");
				return;
			}

			ctx.ui.notify(
				"Commands: review now; proposal list|show|apply|reject; stats; inactive; reminder on|off|status; disable|enable|purge <scope> <name>",
				"info",
			);
		},
	});
}
