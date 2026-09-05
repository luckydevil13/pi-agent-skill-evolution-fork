import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import skillEvolution from "../extensions/skill-evolution.ts";
import { createProposalLedger } from "../extensions/proposal-ledger.ts";
import { createSkillEvolutionEngine } from "../extensions/skill-evolution-engine.ts";

function paths(root) {
	return { globalSkills: join(root, "global-skills"), projectSkills: join(root, "project-skills"), globalState: join(root, "global-state"), projectState: join(root, "project-state") };
}
function createSkill(root, name = "demo") {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Demo\n---\n# Demo\n`);
}
function session(root, trustedProject = true) {
	return { cwd: root, trustedProject, entries: [], mode: "cli", hasUI: false, notify() {}, confirm: async () => true, appendEntry() {} };
}

test("Pi extension registers the tool and skill-evolution command", () => {
	const events = new Map();
	const tools = [];
	const commands = [];
	const pi = {
		on(name, handler) { events.set(name, handler); },
		registerTool(tool) { tools.push(tool); },
		registerCommand(name, command) { commands.push({ name, command }); },
	};
	skillEvolution(pi);
	assert.ok(events.has("session_start"));
	assert.ok(events.has("agent_settled"));
	assert.equal(tools[0].name, "skill_manage");
	assert.equal(commands[0].name, "skill-evolution");
});

test("command smoke covers review, proposals, reminders, and package state", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "skill-command-smoke-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const roots = paths(root);
	mkdirSync(roots.globalSkills, { recursive: true });
	createSkill(roots.globalSkills);
	const host = session(root);
	const engine = createSkillEvolutionEngine({ paths: roots, config: { reviewInterval: 10, maxProposals: 3, inactiveDays: 30 }, model: async ({ systemPrompt }) => systemPrompt.includes("Select existing")
		? '{"relevantSkills":[]}'
		: '{"status":"proposals","proposals":[{"title":"Generated","rationale":"repeated workflow","scope":"global","operations":[{"type":"patch","skillName":"demo","path":"SKILL.md","find":"# Demo","replace":"# Generated"}]}]}' });
	engine.initialize(host);

	assert.match(await engine.command("review now", host), /No unreviewed/);
	engine.onAgentEnd([{ role: "user", content: "repeatable workflow" }]);
	engine.onAgentSettled(host);
	assert.match(await engine.command("review now", host), /Queued review/);
	for (let attempt = 0; attempt < 20 && !existsSync(roots.globalState); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.match(await engine.command("proposal list", host), /Generated/);
	assert.match(await engine.command("stats", host), /global/);
	assert.match(await engine.command("inactive", host), /global: none/);
	assert.match(await engine.command("reminder status", host), /global=off/);
	assert.match(await engine.command("reminder on", host), /global=on/);
	assert.match(await engine.command("reminder off", host), /global=off/);

	const ledger = createProposalLedger(roots);
	const generated = ledger.list("global")[0];
	assert.match(await engine.command(`proposal show ${generated.id}`, host), /Generated/);
	assert.match(await engine.command(`proposal reject ${generated.id}`, host), /Rejected proposal/);

	const applied = await ledger.save({ title: "Created", rationale: "test", scope: "global", operations: [{ type: "create", skillName: "created", description: "Created skill", content: "# Created" }] });
	assert.match(await engine.command(`proposal apply ${applied.id}`, host), /Applied proposal/);
	assert.equal(existsSync(join(roots.globalSkills, "created", "SKILL.md")), true);

	assert.match(await engine.command("disable global demo", host), /Disabled/);
	assert.match(await engine.command("enable global demo", host), /Enabled/);
	assert.match(await engine.command("purge global created", host), /Purged/);
	assert.equal(existsSync(join(roots.globalSkills, "created")), false);
});
