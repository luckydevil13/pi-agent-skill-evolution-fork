import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ActivityStore, type ActivityPaths } from "./activity-store.ts";
import { createSkillMutations, type SkillMutations } from "./skill-mutations.ts";
import { createReviewPipeline, serializeRun, type ReviewRun, type ReviewConfig as PipelineConfig } from "./review-pipeline.ts";
import { createProposalLedger, type Proposal, type ProposalOperation } from "./proposal-ledger.ts";
import { discoverSkills, requireSkillName, resolveSkill, safePackagePath, skillDirectory, type Scope } from "./skill-package.ts";

export interface EnginePaths extends ActivityPaths {}
export interface EngineConfig extends PipelineConfig { inactiveDays: number }
export interface EngineRun extends ReviewRun {}
export interface EngineEntry { type: string; customType?: string; data?: unknown }
export interface EngineSession {
  cwd: string;
  trustedProject: boolean;
  entries: readonly EngineEntry[];
  mode?: string;
  hasUI?: boolean;
  notify(message: string, level?: "info" | "error"): void;
  confirm?(title: string, message: string): Promise<boolean>;
  appendEntry(type: string, data: unknown): void;
}
export interface EngineModelRequest { model?: string; systemPrompt: string; prompt: string; signal: AbortSignal }
export interface SkillEvolutionEngineOptions {
  paths: EnginePaths;
  config: EngineConfig;
  model?: (request: EngineModelRequest) => Promise<string>;
  authoringReference?: string;
  now?: () => number;
}
export const RUN_ENTRY_TYPE = "skill-evolution-run-v2";
export const REVIEW_STATE_ENTRY_TYPE = "skill-evolution-review-state-v2";
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function configOf(config: EngineConfig): EngineConfig {
  return { ...config, reviewInterval: Math.max(1, Math.floor(config.reviewInterval)), maxProposals: Math.max(1, Math.min(3, Math.floor(config.maxProposals))), inactiveDays: Math.max(1, Math.floor(config.inactiveDays)) };
}
function scopes(trusted: boolean): Scope[] { return trusted ? ["global", "project"] : ["global"]; }
function proposalSummary(p: Proposal): string { return `# ${p.title}\n\nID: ${p.id}\nStatus: ${p.status}\nScope: ${p.scope}\nCreated: ${p.createdAt}\n\n${p.rationale}\n\nOperations:\n${p.operations.map((o) => `  - ${o.type} ${o.skillName}${o.type === "patch" || o.type === "write" ? `/${o.path}` : ""}`).join("\n")}`; }
function truncate(value: string, bytes = 50 * 1024): string { if (Buffer.byteLength(value) <= bytes) return value; let result = value.slice(0, bytes); while (Buffer.byteLength(result) > bytes) result = result.slice(0, -1); return `${result}\n\n[Output truncated at ${bytes} bytes.]`; }
function section(value: string, query?: string): string { if (!query) return truncate(value); const start = value.indexOf(query); if (start < 0) return truncate(value.slice(0, 2000)); const end = value.indexOf("\n#", start + query.length); return truncate(value.slice(start, end < 0 ? undefined : end)); }

/** Pure session policy. Pi, tests, or another host provide only EngineSession. */
export class SkillEvolutionEngine {
  readonly paths: EnginePaths;
  readonly activity: ActivityStore;
  readonly mutations: SkillMutations;
  readonly config: EngineConfig;
  private readonly options: SkillEvolutionEngineOptions;
  private pendingMessages: unknown[] = [];
  private pendingRuns: EngineRun[] = [];
  private nextIndex = 1;
  private reviewedThrough = 0;
  private reviewQueue: EngineRun[][] = [];
  private reviewing = false;
  private stopped = false;

  constructor(options: SkillEvolutionEngineOptions) {
    this.options = options; this.paths = options.paths; this.config = configOf(options.config);
    this.activity = new ActivityStore(this.paths); this.mutations = createSkillMutations(this.paths, this.activity);
  }

  initialize(session: EngineSession): void {
    this.stopped = false; this.pendingMessages = []; this.reviewQueue = []; this.reviewing = false;
    this.pendingRuns = []; this.nextIndex = 1; this.reviewedThrough = 0;
    for (const entry of session.entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType === RUN_ENTRY_TYPE) { const run = entry.data as EngineRun; if (run && typeof run.index === "number" && typeof run.text === "string") { this.pendingRuns.push(run); this.nextIndex = Math.max(this.nextIndex, run.index + 1); } }
      if (entry.customType === REVIEW_STATE_ENTRY_TYPE) { const state = entry.data as { reviewedThrough?: number }; this.reviewedThrough = Math.max(this.reviewedThrough, state?.reviewedThrough ?? 0); }
    }
    const uniqueRuns = new Map<number, EngineRun>();
    for (const run of this.pendingRuns) if (run.index > this.reviewedThrough) uniqueRuns.set(run.index, run);
    this.pendingRuns = [...uniqueRuns.values()].sort((a, b) => a.index - b.index);
    this.mutations.removeLegacyStats();
  }

  async reminders(session: EngineSession): Promise<void> {
    const enabled = scopes(session.trustedProject);
    let choice: boolean | undefined;
    if (enabled.some((scope) => this.activity.readStats(scope).reminderEnabled === null)) choice = session.mode === "tui" && session.confirm ? await session.confirm("Inactive skill reminders", "Enable weekly inactive-skill reminders?") : false;
    for (const scope of enabled) {
      const stats = this.activity.readStats(scope);
      if (stats.reminderEnabled === null) { stats.reminderEnabled = choice ?? false; await this.activity.updateStatsFile(scope, (current) => { current.reminderEnabled = stats.reminderEnabled; }); }
      if (!stats.reminderEnabled) continue;
      const last = stats.lastReminderCheck ? new Date(stats.lastReminderCheck).getTime() : 0;
      if (last && (this.options.now?.() ?? Date.now()) - last < REMINDER_INTERVAL_MS) continue;
      const inactive = this.activity.inactiveSkills(scope, this.config.inactiveDays);
      const checked = new Date().toISOString(); await this.activity.updateStatsFile(scope, (current) => { current.lastReminderCheck = checked; });
      if (inactive.length && session.hasUI !== false) session.notify(`Inactive ${scope} skills: ${inactive.join(", ")}`, "info");
    }
  }

  onAgentEnd(messages: readonly unknown[]): void { this.pendingMessages.push(...messages); }
  onAgentSettled(session: EngineSession): void {
    if (this.stopped) return;
    const run: EngineRun = { index: this.nextIndex++, timestamp: new Date().toISOString(), text: serializeRun(this.pendingMessages) };
    this.pendingMessages = []; this.pendingRuns.push(run); session.appendEntry(RUN_ENTRY_TYPE, run);
    while (this.pendingRuns.length >= this.config.reviewInterval) this.reviewQueue.push(this.pendingRuns.splice(0, this.config.reviewInterval));
    void this.drain(session);
  }
  async stop(): Promise<void> { this.stopped = true; this.reviewQueue = []; }

  async reviewNow(session: EngineSession): Promise<number> { const batch = this.pendingRuns.splice(0); if (!batch.length) return 0; this.reviewQueue.push(batch); void this.drain(session); return batch.length; }
  private async drain(session: EngineSession): Promise<void> {
    if (this.reviewing || !this.options.model) return; this.reviewing = true;
    try { while (this.reviewQueue.length && !this.stopped) { const runs = this.reviewQueue.shift()!; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 120000); try {
      const pipeline = createReviewPipeline({ paths: this.paths, config: this.config, trustedProject: session.trustedProject, authoringReference: this.options.authoringReference ?? "", model: (request) => this.options.model!({ ...request, model: request.model }), });
      const proposals = await pipeline.review(runs, controller.signal); if (proposals.length && session.hasUI !== false) session.notify(`Skill evolution created ${proposals.length} proposal(s). Use /skill-evolution proposal list.`, "info");
    } catch (error) { session.notify(`Skill evolution review failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    finally { clearTimeout(timeout); const last = runs.at(-1)?.index; if (last) { this.reviewedThrough = Math.max(this.reviewedThrough, last); session.appendEntry(REVIEW_STATE_ENTRY_TYPE, { reviewedThrough: this.reviewedThrough }); } }
    } } finally { this.reviewing = false; }
  }

  async recordInput(textValue: string, session: EngineSession): Promise<void> { const match = textValue.match(/^\/skill:([a-z0-9-]+)(?:\s|$)/); if (!match) return; try { const skill = resolveSkill(this.paths, match[1]); if (skill.scope === "global" || session.trustedProject) await this.activity.recordActivity(skill.scope, skill.name, "explicitInvocation", skill.description); } catch { /* unknown skill is pi's concern */ } }
  async recordRead(pathValue: string, session: EngineSession): Promise<void> { const requested = resolve(session.cwd, pathValue.replace(/^@/, "")); const skill = discoverSkills(this.paths).find((candidate) => resolve(candidate.path) === requested); if (skill && (skill.scope === "global" || session.trustedProject)) await this.activity.recordActivity(skill.scope, skill.name, "skillLoad", skill.description); }

  async executeTool(params: Record<string, unknown>, session: EngineSession): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
    const operation = text(params.operation); if (operation === "list") { const lines = discoverSkills(this.paths).filter((s) => s.scope === "global" || session.trustedProject).map((s) => `- [${s.scope}] **${s.name}**: ${s.description || "(no description)"}`); return { content: [{ type: "text", text: truncate(lines.join("\n") || "No skills found") }], details: {} }; }
    const name = requireSkillName(text(params.skillName)); const requested = params.scope as Scope | undefined; if (requested === "project" && !session.trustedProject) throw new Error("Project-scope skill operations require a trusted project");
    if (operation === "inspect") { const skill = resolveSkill(this.paths, name, requested); if (skill.scope === "project" && !session.trustedProject) throw new Error("Inspecting a project skill requires a trusted project"); await this.activity.recordActivity(skill.scope, name, "management", skill.description); return { content: [{ type: "text", text: section(readFileSync(skill.path, "utf8"), text(params.content)) }], details: { path: skill.path, scope: skill.scope } }; }
    if (operation === "patch" && !params.proposalId) { if (!requested) throw new Error('Body-only patch requires explicit "scope"'); const path = await this.mutations.bodyPatch(requested, name, text(params.find), text(params.replace)); return { content: [{ type: "text", text: `Patched ${path}` }], details: { path } }; }
    const id = text(params.proposalId); if (!id) throw new Error(`${operation} requires an approved proposalId`); const ledger = createProposalLedger(this.paths); const proposal = ledger.find(id); if (proposal.scope === "project" && !session.trustedProject) throw new Error("Applying a project proposal requires a trusted project"); const expected = operation === "write_file" ? "write" : operation === "delete" ? "disable" : operation; if (!proposal.operations.some((item) => item.skillName === name && item.type === expected)) throw new Error(`Proposal ${id} has no ${expected} operation for skill "${name}"`); await ledger.apply(proposal); return { content: [{ type: "text", text: `Applied proposal ${id}. Run /reload if discovery data changed.` }], details: { proposalId: id } };
  }

  async command(args: string, session: EngineSession): Promise<string | undefined> {
    const tokens = args.trim().split(/\s+/).filter(Boolean); if (args.trim() === "review now") { const count = await this.reviewNow(session); return count ? `Queued review of ${count} agent run(s)` : "No unreviewed agent runs"; }
    const ledger = createProposalLedger(this.paths); if (tokens[0] === "proposal") { if (tokens[1] === "list") return ledger.list(session.trustedProject ? undefined : "global").map((p) => `${p.id} [${p.status}/${p.scope}] ${p.title}`).join("\n") || "No proposals found"; if ((tokens[1] === "show" || tokens[1] === "apply" || tokens[1] === "reject") && tokens[2]) { const p = ledger.find(tokens[2]); if (tokens[1] === "show") return proposalSummary(p); if (tokens[1] === "reject") { await ledger.reject(p); return `Rejected proposal ${p.id}`; } await ledger.apply(p); return `Applied proposal ${p.id}. Run /reload if discovery data changed.`; } }
    if (args.trim() === "stats" || args.trim() === "inactive") { return scopes(session.trustedProject).map((scope) => args.trim() === "inactive" ? `${scope}: ${this.activity.inactiveSkills(scope, this.config.inactiveDays).join(", ") || "none"}` : `[${scope}]\n${Object.entries(this.activity.readStats(scope).skills).sort().map(([n, e]) => `${n}: explicit=${e.explicitInvocationCount}, loads=${e.skillLoadCount}, management=${e.managementOperations}`).join("\n")}`).join("\n"); }
    if (tokens[0] === "reminder" && ["on", "off", "status"].includes(tokens[1])) { for (const scope of scopes(session.trustedProject)) if (tokens[1] !== "status") await this.activity.updateStatsFile(scope, (s) => { s.reminderEnabled = tokens[1] === "on"; }); return `Inactive reminders: ${scopes(session.trustedProject).map((s) => `${s}=${this.activity.readStats(s).reminderEnabled ? "on" : "off"}`).join(", ")}`; }
    if (["disable", "enable", "purge"].includes(tokens[0]) && tokens[1] && tokens[2]) { const scope = tokens[1] as Scope; if (scope === "project" && !session.trustedProject) throw new Error("Project-scope commands require a trusted project"); const name = requireSkillName(tokens[2]); if (tokens[0] !== "purge") { await this.mutations.setEnabled(scope, name, tokens[0] === "enable"); return `${tokens[0] === "enable" ? "Enabled" : "Disabled"} ${scope} skill "${name}". Run /reload.`; } const confirmed = session.confirm ? await session.confirm("Purge skill package?", `Delete package "${name}" permanently?`) : false; if (await this.mutations.purge(scope, name, confirmed)) return `Purged ${scope} skill "${name}". Run /reload.`; return undefined; }
    return "Commands: review now; proposal list|show|apply|reject; stats; inactive; reminder on|off|status; disable|enable|purge <scope> <name>";
  }
}
export function createSkillEvolutionEngine(options: SkillEvolutionEngineOptions): SkillEvolutionEngine { return new SkillEvolutionEngine(options); }
