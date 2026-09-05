import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createSkillEvolutionEngine, type EngineConfig, type EngineEntry, type EngineSession } from "./skill-evolution-engine.ts";

const REVIEW_GUARDRAIL = "\n\n## Skill Evolution\nDo not create or fully rewrite skills directly. Skill creation, frontmatter changes, package-file changes, and disabling require a skill-evolution proposal.\n";
const SkillManageParameters = Type.Object({
  operation: StringEnum(["create", "edit", "patch", "delete", "list", "inspect", "write_file"] as const),
  skillName: Type.Optional(Type.String()), scope: Type.Optional(StringEnum(["global", "project"] as const)),
  proposalId: Type.Optional(Type.String()), description: Type.Optional(Type.String()), content: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()), find: Type.Optional(Type.String()), replace: Type.Optional(Type.String()),
});

function paths(cwd: string) {
  const agent = join(process.env.HOME ?? "/root", ".pi", "agent");
  return { globalSkills: process.env.PI_SKILL_EVOLUTION_DIR ?? join(agent, "skills"), projectSkills: join(cwd, ".agents", "skills"), globalState: join(agent, "skill-evolution"), projectState: join(cwd, CONFIG_DIR_NAME, "skill-evolution") };
}
function configFor(root: ReturnType<typeof paths>): EngineConfig {
  const read = (path: string): Record<string, unknown> => { if (!existsSync(path)) return {}; try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return {}; } };
  const merged: Record<string, unknown> = { reviewInterval: 10, maxProposals: 3, inactiveDays: 30, ...read(join(root.globalState, "config.json")), ...read(join(root.projectState, "config.json")) };
  return { reviewModel: typeof merged.reviewModel === "string" ? merged.reviewModel : undefined, reviewInterval: Number(merged.reviewInterval), maxProposals: Number(merged.maxProposals), inactiveDays: Number(merged.inactiveDays) };
}
function session(ctx: ExtensionContext, appendEntry: (type: string, data: unknown) => void): EngineSession {
  return { cwd: ctx.cwd, trustedProject: ctx.isProjectTrusted(), entries: ctx.sessionManager.getBranch().map((entry) => { const value = entry as unknown as { type: string; customType?: string; data?: unknown }; return { type: value.type, customType: value.customType, data: value.data }; }) as EngineEntry[], mode: ctx.mode, hasUI: ctx.hasUI, notify: (message, level = "info") => ctx.ui.notify(message, level), confirm: (title, message) => ctx.ui.confirm(title, message), appendEntry };
}
function extract(response: { content: Array<{ type: string; text?: string }> }): string { return response.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim(); }

export default function skillEvolution(pi: ExtensionAPI) {
  let ctxSession: EngineSession | undefined;
  let engine = createSkillEvolutionEngine({ paths: paths(process.cwd()), config: { reviewInterval: 10, maxProposals: 3, inactiveDays: 30 }, model: async () => { throw new Error("Reviewer is not initialized"); } });
  pi.on("before_agent_start", (event) => event.systemPrompt.includes(REVIEW_GUARDRAIL) ? undefined : { systemPrompt: event.systemPrompt + REVIEW_GUARDRAIL });
  pi.on("session_start", async (_event, ctx) => {
    const root = paths(ctx.cwd); const config = configFor(root);
    const model = async ({ model, systemPrompt, prompt, signal }: { model?: string; systemPrompt: string; prompt: string; signal: AbortSignal }) => {
      let selected = ctx.model;
      if (model) { const slash = model.indexOf("/"); if (slash > 0) { const candidate = ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1)); if (candidate && ctx.modelRegistry.hasConfiguredAuth(candidate)) selected = candidate; } }
      if (!selected) throw new Error("No reviewer model is available");
      return extract(await ctx.modelRegistry.complete(selected, { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { maxTokens: 4096, signal, cacheRetention: "none", sessionId: randomUUID() }));
    };
    engine = createSkillEvolutionEngine({ paths: root, config, model, authoringReference: "Write ordered steps with checkable completion criteria." });
    ctxSession = session(ctx, (type, data) => pi.appendEntry(type, data)); engine.initialize(ctxSession); await engine.reminders(ctxSession);
  });
  pi.on("session_shutdown", () => { void engine.stop(); ctxSession = undefined; });
  pi.on("agent_end", (event) => engine.onAgentEnd(event.messages));
  pi.on("agent_settled", (_event, ctx) => { if (ctx.isIdle() && ctxSession) engine.onAgentSettled(ctxSession); });
  pi.on("input", async (event) => { if (ctxSession) await engine.recordInput(event.text, ctxSession); return { action: "continue" as const }; });
  pi.on("tool_call", async (event, ctx) => { if (event.toolName === "read" && typeof (event.input as { path?: unknown }).path === "string" && /SKILL\.md$/i.test((event.input as { path: string }).path) && ctxSession) await engine.recordRead((event.input as { path: string }).path, ctxSession); });
  pi.registerTool({ name: "skill_manage", label: "Skill Manager", description: "Inspect and list skills, apply patches, or execute an approved proposal.", parameters: SkillManageParameters, async execute(_id, params, _signal, _update, ctx) { if (!ctxSession) throw new Error("Session is not initialized"); return engine.executeTool(params as Record<string, unknown>, ctxSession); } });
  pi.registerCommand("skill-evolution", { description: "Review skill evolution proposals, statistics, reminders, and disabled skills", getArgumentCompletions: () => null, handler: async (args, ctx) => { if (!ctxSession) return; const result = await engine.command(args, ctxSession); if (result) ctx.ui.notify(result, "info"); } });
}
