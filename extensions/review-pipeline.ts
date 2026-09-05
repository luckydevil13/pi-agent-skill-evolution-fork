// Review pipeline: turns completed agent runs into persisted proposals.
// Deliberately independent from pi and typebox; the model call is the only
// runtime seam supplied by the caller.
import { readFileSync } from "node:fs";
import { discoverSkills, type SkillRoots, type Scope } from "./skill-package.ts";
import { createProposalLedger, type Proposal, type ProposalDraft, type ProposalOperation } from "./proposal-ledger.ts";
import { EGRESS_BUDGETS, serializeRun, truncateUtf8 } from "./egress-redaction.ts";

export { serializeRun };

export interface ReviewRun {
	index: number;
	timestamp: string;
	text: string;
}

export interface ReviewConfig {
	reviewModel?: string;
	reviewInterval: number;
	maxProposals: number;
}

export interface ModelRequest {
	model?: string;
	systemPrompt: string;
	prompt: string;
	signal: AbortSignal;
}

export type ModelCall = (request: ModelRequest) => Promise<string>;

export interface ReviewPipelinePaths extends SkillRoots {
	globalState: string;
	projectState: string;
}

export interface ReviewPipelineOptions {
	paths: ReviewPipelinePaths;
	config: ReviewConfig;
	model: ModelCall;
	trustedProject: boolean;
	authoringReference: string;
	maxRunBytes?: number;
	maxReviewBytes?: number;
	timeoutMs?: number;
}

export const SELECTOR_SYSTEM_PROMPT = `Select existing skills that may cover the supplied workflows.
Return JSON only as {"relevantSkills":["scope:name", ...]}.
Select at most five. Return an empty array if no existing skill is relevant.`;

export const REVIEW_SYSTEM_PROMPT = `You are the isolated reviewer for skill evolution.
Find reusable workflows in the supplied agent runs. Prefer updating an existing skill over creating a duplicate.
A proposal is justified only when a workflow repeated, or when it captured a difficult error, recovery, or non-obvious sequence.
Return JSON only. Do not use Markdown fences. Never include secrets.
The final JSON is either {"status":"no_change","proposals":[]} or:
{"status":"proposals","proposals":[{"title":"...","rationale":"...","scope":"global|project","operations":[...]}]}.
Allowed operations:
- {"type":"create","skillName":"...","description":"...","content":"SKILL.md body without frontmatter"}
- {"type":"edit","skillName":"...","description":"optional replacement","content":"replacement SKILL.md body"}
- {"type":"patch","skillName":"...","path":"SKILL.md or relative text path","find":"unique exact text","replace":"..."}
- {"type":"write","skillName":"...","path":"relative text path","content":"..."}
- {"type":"disable","skillName":"..."}`;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Parses fenced and unfenced JSON, but never accepts a non-object response. */
export function parseJsonObject<T>(text: string): T {
	const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Reviewer returned no JSON object");
	const value: unknown = JSON.parse(unfenced.slice(start, end + 1));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reviewer returned no JSON object");
	return value as T;
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent.reason);
	const timer = setTimeout(() => controller.abort(new Error("Review timed out")), timeoutMs);
	if (parent.aborted) controller.abort(parent.reason);
	else parent.addEventListener("abort", onAbort, { once: true });
	return { signal: controller.signal, cleanup: () => { clearTimeout(timer); parent.removeEventListener("abort", onAbort); } };
}

function normalizeConfig(config: ReviewConfig): ReviewConfig {
	return {
		reviewModel: config.reviewModel,
		reviewInterval: Math.max(1, Math.floor(config.reviewInterval)),
		maxProposals: Math.max(1, Math.min(3, Math.floor(config.maxProposals))),
	};
}

export class ReviewPipeline {
	private readonly options: ReviewPipelineOptions;
	private readonly ledger;

	constructor(options: ReviewPipelineOptions) {
		this.options = options;
		this.ledger = createProposalLedger(options.paths);
	}

	batchRuns(runs: ReviewRun[]): ReviewRun[][] {
		const size = normalizeConfig(this.options.config).reviewInterval;
		const batches: ReviewRun[][] = [];
		for (let index = 0; index + size <= runs.length; index += size) batches.push(runs.slice(index, index + size));
		return batches;
	}

	async review(runs: ReviewRun[], parentSignal: AbortSignal = new AbortController().signal): Promise<Proposal[]> {
		if (!runs.length) return [];
		const config = normalizeConfig(this.options.config);
		const signal = timeoutSignal(parentSignal, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			let lastError: unknown;
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					return await this.runAttempt(runs, config, signal.signal);
				} catch (error) {
					lastError = error;
					if (signal.signal.aborted) throw error;
				}
			}
			throw lastError;
		} finally {
			signal.cleanup();
		}
	}

	private async runAttempt(runs: ReviewRun[], config: ReviewConfig, signal: AbortSignal): Promise<Proposal[]> {
		if (signal.aborted) throw new Error("Review aborted");
		const maxRunBytes = this.options.maxRunBytes ?? EGRESS_BUDGETS.runBytes;
		const reviewText = truncateUtf8(runs.map((run) => `## Run ${run.index} (${run.timestamp})\n${truncateUtf8(run.text, maxRunBytes)}`).join("\n\n"), this.options.maxReviewBytes ?? EGRESS_BUDGETS.reviewBytes);
		const catalog = discoverSkills(this.options.paths).filter((skill) => skill.scope === "global" || this.options.trustedProject);
		const catalogText = catalog.map((skill) => `- ${skill.scope}:${skill.name} — ${skill.description}`).join("\n");
		const call = (systemPrompt: string, prompt: string) => this.options.model({ model: config.reviewModel, systemPrompt, prompt, signal });

		const selection = parseJsonObject<{ relevantSkills?: unknown }>(await call(SELECTOR_SYSTEM_PROMPT, `Existing skills:\n${catalogText || "(none)"}\n\nAgent runs:\n${reviewText}`));
		const relevant = new Set(Array.isArray(selection.relevantSkills) ? selection.relevantSkills.filter((item): item is string => typeof item === "string").slice(0, 5) : []);
		const bodies = catalog.filter((skill) => relevant.has(`${skill.scope}:${skill.name}`)).map((skill) => `## ${skill.scope}:${skill.name}\n${truncateUtf8(readFileSync(skill.path, "utf8"), EGRESS_BUDGETS.skillBodyBytes)}`).join("\n\n");
		const result = parseJsonObject<{ status?: string; proposals?: unknown }>(await call(REVIEW_SYSTEM_PROMPT, `Maximum proposals: ${config.maxProposals}\n\nAuthoring reference:\n${this.options.authoringReference}\n\nExisting skill catalog:\n${catalogText || "(none)"}\n\nRelevant skill bodies:\n${bodies || "(none selected)"}\n\nAgent runs:\n${reviewText}`));
		if (result.status === "no_change" || !Array.isArray(result.proposals) || result.proposals.length === 0) return [];
		const proposals: Proposal[] = [];
		for (const draft of result.proposals.slice(0, config.maxProposals) as ProposalDraft[]) {
			if (signal.aborted) throw new Error("Review aborted");
			if (draft.scope === "project" && !this.options.trustedProject) continue;
			proposals.push(await this.ledger.save(draft));
		}
		return proposals;
	}
}

export function createReviewPipeline(options: ReviewPipelineOptions): ReviewPipeline {
	return new ReviewPipeline(options);
}

export type { Proposal, ProposalOperation, Scope };
