import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillEvolutionEngine, RUN_ENTRY_TYPE, REVIEW_STATE_ENTRY_TYPE } from "../extensions/skill-evolution-engine.ts";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "skill-engine-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { globalSkills: join(root, "global-skills"), projectSkills: join(root, "project-skills"), globalState: join(root, "global-state"), projectState: join(root, "project-state") };
  mkdirSync(join(paths.globalSkills, "demo"), { recursive: true });
  writeFileSync(join(paths.globalSkills, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n# Demo\n");
  return paths;
}
function host(paths, entries = [], trustedProject = true) {
  const notifications = []; const appended = [];
  return { session: { cwd: "/tmp/project", trustedProject, entries, notify: (message) => notifications.push(message), confirm: async () => true, appendEntry: (type, data) => appended.push({ type, data }) }, notifications, appended, paths };
}
function engine(paths, model = async () => '{"status":"no_change","proposals":[]}') {
  return createSkillEvolutionEngine({ paths, config: { reviewInterval: 2, maxProposals: 3, inactiveDays: 30 }, model });
}

 test("restores cursor and filters duplicate run entries", (t) => {
  const paths = setup(t);
  const h = host(paths, [
    { type: "custom", customType: RUN_ENTRY_TYPE, data: { index: 1, timestamp: "x", text: "old" } },
    { type: "custom", customType: RUN_ENTRY_TYPE, data: { index: 2, timestamp: "x", text: "reviewed" } },
    { type: "custom", customType: RUN_ENTRY_TYPE, data: { index: 3, timestamp: "x", text: "pending" } },
    { type: "custom", customType: RUN_ENTRY_TYPE, data: { index: 3, timestamp: "x", text: "pending" } },
    { type: "custom", customType: REVIEW_STATE_ENTRY_TYPE, data: { reviewedThrough: 2 } },
  ]);
  const e = engine(paths); e.initialize(h.session); e.onAgentSettled(h.session);
  assert.equal(h.appended[0].data.index, 4);
});

test("queues complete review windows in order", async (t) => {
  const paths = setup(t); const h = host(paths); let calls = 0;
  const e = engine(paths, async () => { calls++; return '{"status":"no_change","proposals":[]}'; }); e.initialize(h.session);
  e.onAgentEnd(["one"]); e.onAgentSettled(h.session); e.onAgentEnd(["two"]); e.onAgentSettled(h.session);
  e.onAgentEnd(["three"]); e.onAgentSettled(h.session); e.onAgentEnd(["four"]); e.onAgentSettled(h.session);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 4); assert.deepEqual(h.appended.filter((x) => x.type === REVIEW_STATE_ENTRY_TYPE).map((x) => x.data.reviewedThrough), [2, 4]);
});

test("persists first reminder choice and only notifies once per interval", async (t) => {
  const paths = setup(t); const h = host(paths); h.session.mode = "tui"; const e = engine(paths); e.initialize(h.session);
  await e.reminders(h.session); await e.reminders(h.session);
  assert.equal(h.notifications.length, 0); assert.equal(e.activity.readStats("global").reminderEnabled, true);
});

test("rejects project operations in an untrusted project", async (t) => {
  const paths = setup(t); const h = host(paths, [], false); const e = engine(paths); e.initialize(h.session);
  await assert.rejects(() => e.command("disable project demo", h.session), /trusted project/);
  await assert.rejects(() => e.executeTool({ operation: "inspect", skillName: "demo", scope: "project" }, h.session), /trusted project/);
});
