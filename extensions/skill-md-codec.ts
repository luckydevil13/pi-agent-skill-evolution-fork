export interface SkillMdParts {
	frontmatter: string;
	body: string;
}

export interface ParsedSkillMd {
	name?: string;
	description?: string;
	body: string;
}

/** Quote a YAML scalar using JSON's double-quoted scalar syntax. */
export function yamlSafeScalar(value: string): string {
	const trimmed = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
	return JSON.stringify(trimmed);
}

export function buildSkillMd(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${yamlSafeScalar(description)}\n---\n\n${body.trim()}\n`;
}

/** Split a valid SKILL.md, preserving the complete frontmatter block. */
export function splitSkillMd(text: string): SkillMdParts {
	const match = text.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
	if (!match) throw new Error("SKILL.md has invalid or missing frontmatter");
	return { frontmatter: match[1], body: match[2] };
}

/** Parse frontmatter for discovery. Invalid or missing frontmatter is treated as a body-only document. */
export function parseFrontmatter(text: string): ParsedSkillMd {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { body: text };
	const values: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		try {
			if (value.startsWith('"')) value = JSON.parse(value) as string;
		} catch {
			// Keep malformed quoted scalars available for display.
		}
		values[key] = value;
	}
	return { name: values.name, description: values.description, body: match[2] };
}

export function replaceDescription(frontmatter: string, description: string): string {
	const lines = frontmatter.split(/\r?\n/);
	const index = lines.findIndex((line) => /^description\s*:/.test(line));
	if (index < 0) throw new Error("SKILL.md frontmatter has no description");
	lines[index] = `description: ${yamlSafeScalar(description)}`;
	return lines.join("\n");
}

export function editSkillMd(text: string, description: string | undefined, body: string): string {
	const split = splitSkillMd(text);
	const frontmatter = description !== undefined ? replaceDescription(split.frontmatter, description) : split.frontmatter;
	return `${frontmatter}${body.trim()}\n`;
}

/** Patch exactly one occurrence in the body while keeping frontmatter byte-for-byte unchanged. */
export function patchSkillMd(text: string, find: string, replace: string): string {
	const before = splitSkillMd(text);
	const count = before.body.split(find).length - 1;
	if (count !== 1) throw new Error(`Patch find text occurs ${count} times in SKILL.md body`);
	const next = `${before.frontmatter}${before.body.replace(find, replace)}`;
	if (splitSkillMd(next).frontmatter !== before.frontmatter) throw new Error("Automatic patch cannot change frontmatter");
	return next;
}
