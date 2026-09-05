import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverSkills,
	fileHash,
	hashText,
	requireSkillName,
	resolveSkill,
	safePackagePath,
	skillDirectory,
	validateSkillName,
} from "../extensions/skill-package.ts";

function skillMd(name, description) {
	return `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`;
}

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "skill-package-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Writes a package `<root>/<directory>/SKILL.md`. */
function writeSkill(root, directory, { name, description } = {}) {
	mkdirSync(join(root, directory), { recursive: true });
	writeFileSync(join(root, directory, "SKILL.md"), skillMd(name ?? directory, description ?? `desc of ${directory}`));
}

// --- name validation ---

test("name validation: accepts valid lowercase names", () => {
	for (const name of ["demo", "a", "my-skill2", "x".repeat(64)]) {
		assert.equal(validateSkillName(name), null, name);
	}
});

test("name validation: empty and overlong names are rejected", () => {
	assert.match(validateSkillName(""), /1-64 characters/);
	assert.match(validateSkillName("x".repeat(65)), /1-64 characters/);
	assert.throws(() => requireSkillName(undefined), /Missing "skillName"/);
	assert.throws(() => requireSkillName(""), /Missing "skillName"/);
});

test("name validation: alphabet is lowercase letters, digits, hyphens only", () => {
	for (const name of ["Demo", "demo_name", "demo!", "демо", "demo name", "demo.txt"]) {
		assert.match(validateSkillName(name), /lowercase letters, digits, and hyphens only/, name);
	}
});

test("name validation: hyphens must not lead, trail, or double", () => {
	assert.match(validateSkillName("-demo"), /must not start or end with a hyphen/);
	assert.match(validateSkillName("demo-"), /must not start or end with a hyphen/);
	assert.match(validateSkillName("a--b"), /must not contain consecutive hyphens/);
});

test("skillDirectory joins a valid name under a root and rejects invalid ones", (t) => {
	const root = tempDir(t);
	assert.equal(skillDirectory(root, "demo"), join(root, "demo"));
	assert.throws(() => skillDirectory(root, "../demo"), /Invalid skill name/);
	assert.throws(() => skillDirectory(root, "Demo"), /Invalid skill name/);
});

// --- safe package path resolution ---

test("package paths: nested relative paths resolve inside the package", (t) => {
	const root = tempDir(t);
	assert.equal(safePackagePath(root, "SKILL.md"), join(root, "SKILL.md"));
	assert.equal(safePackagePath(root, "contexts/guide.md"), join(root, "contexts", "guide.md"));
	assert.throws(() => safePackagePath(root, "deep/nested/../../file.txt"), /Unsafe package path/);
});

test("package paths: absolute paths and parent traversal are rejected", (t) => {
	const root = tempDir(t);
	assert.throws(() => safePackagePath(root, "/etc/passwd"), /Unsafe package path/);
	assert.throws(() => safePackagePath(root, "../outside.md"), /Unsafe package path/);
	assert.throws(() => safePackagePath(root, "a/../../outside.md"), /Unsafe package path/);
	assert.throws(() => safePackagePath(root, ""), /Unsafe package path/);
});

test("package paths: symlinks leading outside the package are rejected", (t) => {
	const root = tempDir(t);
	const outside = tempDir(t);
	const outsideFile = join(outside, "secret.md");
	writeFileSync(outsideFile, "x");

	mkdirSync(join(root, "sub"), { recursive: true });
	symlinkSync(outside, join(root, "sub", "link"));
	assert.throws(() => safePackagePath(root, "sub/link/secret.md"), /Path escapes skill package/);

	symlinkSync(outsideFile, join(root, "leak.md"));
	assert.throws(() => safePackagePath(root, "leak.md"), /Path escapes skill package/);

	// a dangling symlink to a missing target outside the package is rejected too
	symlinkSync(join(outside, "missing"), join(root, "dangling"));
	assert.throws(() => safePackagePath(root, "dangling/new.txt"), /Path escapes skill package/);
});

test("package paths: symlinks staying inside the package are allowed", (t) => {
	const root = tempDir(t);
	mkdirSync(join(root, "real"), { recursive: true });
	symlinkSync(join(root, "real"), join(root, "alias"));
	assert.equal(safePackagePath(root, "alias/file.md"), join(root, "alias", "file.md"));
});

// --- hashing ---

test("hashing: sha256 of text and of file contents", (t) => {
	const root = tempDir(t);
	const digest = createHash("sha256").update("hello").digest("hex");
	assert.equal(hashText("hello"), digest);

	writeSkill(root, "demo");
	const path = join(root, "demo", "SKILL.md");
	assert.equal(fileHash(path), createHash("sha256").update(skillMd("demo", "desc of demo")).digest("hex"));
	assert.equal(fileHash(join(root, "missing")), null);
	assert.equal(fileHash(join(root, "demo")), null); // a directory is not a file
});

// --- registry ---

test("registry: discovery finds both scopes, skips disabled and unreadable packages", (t) => {
	const globalRoot = tempDir(t);
	const projectRoot = tempDir(t);

	writeSkill(globalRoot, "alpha"); // name falls back to the directory name
	writeSkill(globalRoot, "beta", { name: "beta-x", description: "Beta skill" });
	writeSkill(globalRoot, ".disabled-old");
	writeSkill(projectRoot, "gamma");

	// broken SKILL.md: it is a directory, so reading fails and the entry is skipped
	mkdirSync(join(globalRoot, "broken", "SKILL.md"), { recursive: true });
	mkdirSync(join(globalRoot, "empty"), { recursive: true }); // no SKILL.md
	writeFileSync(join(globalRoot, "notes.md"), "not a package"); // a plain file, not a package dir

	const records = discoverSkills({ globalSkills: globalRoot, projectSkills: projectRoot });
	const byName = Object.fromEntries(records.map((record) => [record.name, record]));

	assert.deepEqual(records.map((record) => record.scope).sort(), ["global", "global", "project"]);
	assert.equal(byName["alpha"].name, "alpha");
	assert.equal(byName["alpha"].scope, "global");
	assert.equal(byName["alpha"].path, join(globalRoot, "alpha", "SKILL.md"));
	assert.equal(byName["beta-x"].description, "Beta skill"); // name from frontmatter
	assert.equal(byName["gamma"].scope, "project");
	assert.equal(records.some((record) => record.name.startsWith(".disabled")), false);
	assert.equal(records.some((record) => record.name === "broken"), false);
	assert.equal(records.some((record) => record.name === "empty"), false);
	assert.equal(records.some((record) => record.name === "notes.md"), false);
});

test("registry: discovery skips a missing root directory", (t) => {
	const root = tempDir(t);
	const missing = join(root, "does-not-exist");
	assert.deepEqual(discoverSkills({ globalSkills: missing, projectSkills: missing }), []);
});

test("registry: resolve disambiguates a both-scope collision", (t) => {
	const globalRoot = tempDir(t);
	const projectRoot = tempDir(t);
	writeSkill(globalRoot, "shared");
	writeSkill(projectRoot, "shared");
	writeSkill(globalRoot, "only-global");
	const roots = { globalSkills: globalRoot, projectSkills: projectRoot };

	assert.throws(() => resolveSkill(roots, "shared"), /exists in both scopes/);
	assert.equal(resolveSkill(roots, "shared", "global").scope, "global");
	assert.equal(resolveSkill(roots, "shared", "project").scope, "project");
	assert.equal(resolveSkill(roots, "only-global").scope, "global");
	assert.throws(() => resolveSkill(roots, "missing"), /was not found/);
	assert.throws(() => resolveSkill(roots, "missing", "project"), /was not found/);
});
