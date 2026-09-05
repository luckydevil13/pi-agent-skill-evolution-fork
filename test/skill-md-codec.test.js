import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSkillMd,
	editSkillMd,
	parseFrontmatter,
	patchSkillMd,
	replaceDescription,
	splitSkillMd,
} from "../extensions/skill-md-codec.ts";

test("build and parse round-trip frontmatter", () => {
	const text = buildSkillMd("demo", "A useful skill", "# Body\n\nDo the thing.");
	assert.deepEqual(parseFrontmatter(text), {
		name: "demo",
		description: "A useful skill",
		body: "\n# Body\n\nDo the thing.\n",
	});
	assert.deepEqual(splitSkillMd(text), {
		frontmatter: '---\nname: demo\ndescription: "A useful skill"\n---\n',
		body: "\n# Body\n\nDo the thing.\n",
	});
});

test("missing and malformed frontmatter remain body-only for discovery", () => {
	assert.deepEqual(parseFrontmatter("plain body"), { body: "plain body" });
	assert.deepEqual(parseFrontmatter("---\nname: unfinished\nbody"), { body: "---\nname: unfinished\nbody" });
	assert.throws(() => splitSkillMd("plain body"), /invalid or missing frontmatter/);
});

test("quotes YAML special characters, whitespace, and line breaks", () => {
	const description = '  quote: "yes"\nnext line\t\u0001  ';
	const text = buildSkillMd("demo", description, "body");
	assert.ok(text.includes('description: "quote: \\\"yes\\\"\\nnext line\\t "'));
	assert.equal(parseFrontmatter(text).description, 'quote: "yes"\nnext line\t ');
});

test("description replacement changes only the description field", () => {
	const original = buildSkillMd("demo", "old", "body");
	const next = editSkillMd(original, "new: value", "updated body");
	assert.equal(parseFrontmatter(next).description, "new: value");
	assert.equal(parseFrontmatter(next).body, "updated body\n");
	assert.equal(replaceDescription(splitSkillMd(original).frontmatter, "new: value"), '---\nname: demo\ndescription: "new: value"\n---\n');
});

test("body patch requires exactly one match", () => {
	const original = buildSkillMd("demo", "description", "find once");
	const next = patchSkillMd(original, "find once", "changed");
	assert.equal(splitSkillMd(next).frontmatter, splitSkillMd(original).frontmatter);
	assert.equal(parseFrontmatter(next).body, "\nchanged\n");
	assert.throws(
		() => patchSkillMd(buildSkillMd("demo", "d", "find find"), "find", "x"),
		/occurs 2 times/,
	);
	assert.throws(() => patchSkillMd(original, "missing", "x"), /occurs 0 times/);
});

test("body patch cannot edit frontmatter or description", () => {
	const original = buildSkillMd("demo", "old description", "body");
	assert.throws(
		() => patchSkillMd(original, 'description: "old description"', 'description: "new"'),
		/occurs 0 times/,
	);
	assert.equal(parseFrontmatter(patchSkillMd(original, "body", "body")).description, "old description");
});
