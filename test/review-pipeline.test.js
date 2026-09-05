import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewPipeline, parseJsonObject, serializeRun } from "../extensions/review-pipeline.ts";

function paths(root) {
	return { globalSkills: join(root, "global-skills"), projectSkills: join(root, "project-skills"), globalState: join(root, "global-state"), projectState: join(root, "project-state") };
}
function temp(t) {
	const root = mkdtempSync(join(tmpdir(), "review-pipeline-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function run() { return [{ index: 1, timestamp: new Date().toISOString(), text: "repeatable workflow" }]; }
function config(maxProposals = 3) { return { reviewInterval: 1, maxProposals }; }
function proposal(scope = "global", name = "new-skill") {
	return { title: name, rationale: "repeated", scope, operations: [{ type: "create", skillName: name, description: "Useful", content: "# Steps" }] };
}
function modelReplies(reviewer) {
	let calls = 0;
	return { calls: () => calls, model: async ({ systemPrompt }) => {
		calls++;
		return systemPrompt.includes("Select existing") ? '{"relevantSkills":[]}' : reviewer;
	} };
}

test("fake model creates a saved proposal with beforeHash", async (t) => {
	const root = temp(t);
	const roots = paths(root);
	const fake = modelReplies(JSON.stringify({ status: "proposals", proposals: [proposal()] }));
	const result = await createReviewPipeline({ paths: roots, config: config(), trustedProject: true, authoringReference: "reference", model: fake.model }).review(run());
	assert.equal(result.length, 1);
	assert.equal(result[0].scope, "global");
	assert.equal(result[0].operations[0].beforeHash, null);
	assert.equal(existsSync(join(roots.globalState, "proposals", `${result[0].id}.json`)), true);
	assert.equal(fake.calls(), 2);
});

test("no_change does not create proposals", async (t) => {
	const root = temp(t);
	const fake = modelReplies('{"status":"no_change","proposals":[]}');
	const result = await createReviewPipeline({ paths: paths(root), config: config(), trustedProject: true, authoringReference: "", model: fake.model }).review(run());
	assert.deepEqual(result, []);
	assert.equal(existsSync(join(root, "global-state")), false);
});

test("fenced response parses and malformed protocol retries, then fails after two attempts", async (t) => {
	assert.deepEqual(parseJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
	const root = temp(t);
	let calls = 0;
	await assert.rejects(() => createReviewPipeline({ paths: paths(root), config: config(), trustedProject: true, authoringReference: "", model: async ({ systemPrompt }) => { calls++; return systemPrompt.includes("Select existing") ? '{"relevantSkills":[]}' : "[]"; } }).review(run()), /no JSON object/);
	assert.equal(calls, 4); // selector + reviewer, repeated once
});

test("limits proposals and drops project proposals in an untrusted project", async (t) => {
	const root = temp(t);
	const fake = modelReplies(JSON.stringify({ status: "proposals", proposals: [proposal("global", "one"), proposal("global", "two"), proposal("project", "three")] }));
	const result = await createReviewPipeline({ paths: paths(root), config: config(2), trustedProject: false, authoringReference: "", model: fake.model }).review(run());
	assert.equal(result.length, 2);
	assert.ok(result.every((item) => item.scope === "global"));
});

test("structural egress allowlist keeps secrets, images, and unknown fields out of prompts", async (t) => {
	const root = temp(t);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "token: sk-test_1234567890123456 apiKey=do-not-send" }, { type: "image", data: "data:image/png;base64," + "A".repeat(1000) }], metadata: "ghp_1234567890123456" },
		{ role: "assistant", content: [{ type: "unknown", payload: "xoxb-1234567890123456" }] },
		{ role: "user", content: "safe text" , hidden: { password: "secret-value" } },
		{ arbitrary: "xoxb-1234567890123456" },
	];
	const serialized = serializeRun(messages);
	assert.match(serialized, /image removed/);
	assert.match(serialized, /unsupported/);
	assert.doesNotMatch(serialized, /sk-test|ghp_|xoxb-|do-not-send|secret-value|data:image/);
	assert.deepEqual(JSON.parse(serialized), [
		{ role: "user", content: [{ type: "text", text: "[secret removed] [secret removed]" }, "[image removed]"] },
		{ role: "assistant", content: ["[unsupported content removed]"] },
		{ role: "user", content: "safe text" },
		"[unsupported message removed]",
	]);

	const prompts = [];
	const model = async ({ systemPrompt, prompt }) => {
		prompts.push(prompt);
		return systemPrompt.includes("Select existing") ? '{"relevantSkills":[]}' : '{"status":"no_change","proposals":[]}';
	};
	await createReviewPipeline({ paths: paths(root), config: config(), trustedProject: true, authoringReference: "", model }).review([{ index: 1, timestamp: new Date().toISOString(), text: serialized }]);
	assert.ok(prompts.every((prompt) => !/sk-test|ghp_|xoxb-|do-not-send|secret-value|data:image/.test(prompt)));
});

test("structural serialization tolerates unexpected and cyclic message values", () => {
	const cyclic = { role: "user", content: "ok" };
	cyclic.self = cyclic;
	assert.doesNotThrow(() => serializeRun([cyclic, null, 42, { role: "user" }]));
});

test("abort interrupts model wait and leaves no proposal files", async (t) => {
	const root = temp(t);
	const controller = new AbortController();
	const pending = createReviewPipeline({ paths: paths(root), config: config(), trustedProject: true, authoringReference: "", model: ({ signal }) => new Promise((_, reject) => {
		const stop = () => reject(new Error("aborted"));
		signal.addEventListener("abort", stop, { once: true });
		setImmediate(() => controller.abort());
	}) }).review(run(), controller.signal);
	await assert.rejects(pending);
	assert.equal(existsSync(join(root, "global-state")), false);
});
