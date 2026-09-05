import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore } from "../extensions/activity-store.ts";

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "activity-store-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function paths(root) {
	return {
		globalSkills: join(root, "global-skills"),
		projectSkills: join(root, "project-skills"),
		globalState: join(root, "global-state"),
		projectState: join(root, "project-state"),
	};
}

function writeSkill(root, name) {
	const skill = join(root, name);
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`);
	return join(skill, "SKILL.md");
}

test("recording activity increments the event and records timestamps", async (t) => {
	const root = tempDir(t);
	const store = new ActivityStore(paths(root));

	await store.recordActivity("global", "demo", "explicitInvocation", "Demo skill");
	await store.recordActivity("global", "demo", "skillLoad");
	await store.recordActivity("global", "demo", "management");

	const stats = store.readStats("global");
	const entry = stats.skills.demo;
	assert.equal(stats.version, 2);
	assert.equal(entry.description, "Demo skill");
	assert.equal(entry.explicitInvocationCount, 1);
	assert.equal(entry.skillLoadCount, 1);
	assert.equal(entry.managementOperations, 1);
	assert.match(entry.created, /^\d{4}-\d{2}-\d{2}T/);
	assert.match(entry.lastExplicitInvocation, /^\d{4}-/);
	assert.match(entry.lastSkillLoad, /^\d{4}-/);
	assert.match(entry.lastManagementOperation, /^\d{4}-/);
});

test("missing, malformed, and old-version stats fall back to defaults", (t) => {
	const root = tempDir(t);
	const activityPaths = paths(root);
	const store = new ActivityStore(activityPaths);

	assert.deepEqual(store.readStats("global"), {
		version: 2,
		reminderEnabled: null,
		lastReminderCheck: null,
		skills: {},
	});

	mkdirSync(activityPaths.globalState, { recursive: true });
	const statsPath = join(activityPaths.globalState, "stats.json");
	writeFileSync(statsPath, "not-json");
	assert.deepEqual(store.readStats("global").skills, {});

	writeFileSync(statsPath, JSON.stringify({ version: 1, skills: { old: {} } }));
	assert.deepEqual(store.readStats("global"), {
		version: 2,
		reminderEnabled: null,
		lastReminderCheck: null,
		skills: {},
	});
});

test("concurrent activity and audit writes are serialized and complete", async (t) => {
	const root = tempDir(t);
	const store = new ActivityStore(paths(root));

	await Promise.all(
		Array.from({ length: 40 }, (_, index) =>
			store.recordActivity("global", "demo", "skillLoad", undefined, {
				action: "load",
				index,
			}),
		),
	);

	assert.equal(store.readStats("global").skills.demo.skillLoadCount, 40);
	const lines = readFileSync(join(paths(root).globalState, "audit.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 40);
	const records = lines.map((line) => JSON.parse(line));
	assert.deepEqual(
		records.map((record) => record.index).sort((a, b) => a - b),
		Array.from({ length: 40 }, (_, index) => index),
	);
});

test("legacy stats are removed without changing new stats", async (t) => {
	const root = tempDir(t);
	const activityPaths = paths(root);
	const store = new ActivityStore(activityPaths);
	mkdirSync(activityPaths.globalSkills, { recursive: true });
	const legacy = join(activityPaths.globalSkills, ".skill-stats.json");
	writeFileSync(legacy, JSON.stringify({ old: "data" }));
	await store.recordActivity("global", "new-skill", "skillLoad");

	store.removeLegacyStats();

	assert.equal(existsSync(legacy), false);
	assert.equal(store.readStats("global").skills["new-skill"].skillLoadCount, 1);
});

test("inactivity uses the threshold and ignores management-only activity", async (t) => {
	const root = tempDir(t);
	const activityPaths = paths(root);
	const store = new ActivityStore(activityPaths);
	const oldPath = writeSkill(activityPaths.globalSkills, "old");
	const recentPath = writeSkill(activityPaths.globalSkills, "recent");
	writeSkill(activityPaths.globalSkills, "managed");
	const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
	utimesSync(oldPath, old, old);
	utimesSync(join(activityPaths.globalSkills, "old"), old, old);

	await store.recordActivity("global", "recent", "skillLoad");
	await store.recordActivity("global", "managed", "management");

	assert.deepEqual(store.inactiveSkills("global", 7), ["managed", "old"]);
	assert.deepEqual(store.inactiveSkills("global", 30), ["managed"]);
	assert.ok(recentPath);
});
