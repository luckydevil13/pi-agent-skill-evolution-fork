import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalLedger } from "../extensions/proposal-ledger.ts";

function paths(root) {
	return { globalSkills: join(root, "global-skills"), projectSkills: join(root, "project-skills"), globalState: join(root, "global-state"), projectState: join(root, "project-state") };
}
function temp(t) {
	const root = mkdtempSync(join(tmpdir(), "proposal-ledger-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function skill(root, name, body = "find") {
	const path = join(root, name, "SKILL.md");
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(path, `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`);
	return path;
}
function create(name = "new-skill") {
	return { type: "create", skillName: name, description: "A useful skill", content: "# Body" };
}

test("save deduplicates identical drafts and stores before hashes", async (t) => {
	const root = temp(t);
	const ledger = new ProposalLedger(paths(root));
	const draft = { title: "Add", rationale: "Needed", scope: "project", operations: [create()] };
	const first = await ledger.save(draft);
	const second = await ledger.save(draft);
	assert.equal(second.id, first.id);
	assert.equal(first.operations[0].beforeHash, null);
});

test("apply marks a proposal stale when a target changes", async (t) => {
	const root = temp(t);
	const target = skill(paths(root).projectSkills, "existing", "old");
	const ledger = new ProposalLedger(paths(root));
	const proposal = await ledger.save({ title: "Edit", rationale: "x", scope: "project", operations: [{ type: "edit", skillName: "existing", content: "new" }] });
	writeFileSync(target, readFileSync(target, "utf8").replace("old", "changed"));
	await assert.rejects(() => ledger.apply(proposal), /stale/);
	assert.equal(ledger.find(proposal.id, "project").status, "stale");
});

test("a mid-transaction fault restores files and removes created directories", async (t) => {
	const root = temp(t);
	const target = skill(paths(root).projectSkills, "existing", "old");
	const ledger = new ProposalLedger(paths(root), { onOperation: (_operation, index) => { if (index === 1) throw new Error("injected fault"); } });
	const proposal = await ledger.save({ title: "Multi", rationale: "x", scope: "project", operations: [
		{ type: "edit", skillName: "existing", content: "changed" }, create("created")
	] });
	await assert.rejects(() => ledger.apply(proposal), /injected fault/);
	assert.match(readFileSync(target, "utf8"), /old/);
	assert.equal(existsSync(join(paths(root).projectSkills, "created")), false);
	assert.equal(ledger.find(proposal.id, "project").status, "pending");
});

test("validation rejects collisions, missing packages, empty creates, and repeated patches", async (t) => {
	const root = temp(t);
	const roots = paths(root);
	skill(roots.projectSkills, "taken");
	const ledger = new ProposalLedger(roots);
	await assert.rejects(() => ledger.save({ title: "x", rationale: "x", scope: "project", operations: [create("taken")] }), /already exists/);
	await assert.rejects(() => ledger.save({ title: "x", rationale: "x", scope: "project", operations: [{ type: "edit", skillName: "missing", content: "x" }] }), /no SKILL.md/);
	await assert.rejects(() => ledger.save({ title: "x", rationale: "x", scope: "project", operations: [{ type: "create", skillName: "empty", description: "", content: "x" }] }), /description/);
	const path = skill(roots.projectSkills, "patchable", "find find");
	const proposal = await ledger.save({ title: "x", rationale: "x", scope: "project", operations: [{ type: "patch", skillName: "patchable", path: "SKILL.md", find: "find", replace: "x" }] });
	await assert.rejects(() => ledger.apply(proposal), /occurs 2 times/);
	assert.match(readFileSync(path, "utf8"), /find find/);
});
