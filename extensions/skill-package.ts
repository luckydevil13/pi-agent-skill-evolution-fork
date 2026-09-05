// Module "skill-package": skill names, package-internal paths, hashes, registry.
// All operations on a skill package as a file entity live here, with no runtime
// dependencies on pi or typebox (the module runs standalone under node --test).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./skill-md-codec.ts";

export type Scope = "global" | "project";

/** Roots of both skill scopes; a skill package lives at `<root>/<skillName>/`. */
export interface SkillRoots {
	globalSkills: string;
	projectSkills: string;
}

export interface SkillRecord {
	name: string;
	description: string;
	scope: Scope;
	path: string;
}

// --- skill name validation ---

export function validateSkillName(name: string): string | null {
	if (!name || name.length > 64) return "Name must be 1-64 characters";
	if (!/^[a-z0-9-]+$/.test(name)) return "Name must contain lowercase letters, digits, and hyphens only";
	if (name.startsWith("-") || name.endsWith("-")) return "Name must not start or end with a hyphen";
	if (name.includes("--")) return "Name must not contain consecutive hyphens";
	return null;
}

export function requireSkillName(name: string | undefined): string {
	if (!name) throw new Error('Missing "skillName"');
	const error = validateSkillName(name);
	if (error) throw new Error(`Invalid skill name "${name}": ${error}`);
	return name;
}

/** Package directory of a skill under a scope root; invalid names are rejected. */
export function skillDirectory(root: string, skillName: string): string {
	return join(root, requireSkillName(skillName));
}

// --- file hashing ---

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function fileHash(path: string): string | null {
	return existsSync(path) && statSync(path).isFile() ? hashText(readFileSync(path, "utf8")) : null;
}

// --- safe resolution of package-internal paths ---

function assertInside(root: string, candidate: string): void {
	const rel = relative(resolve(root), resolve(candidate));
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Path escapes skill package: ${candidate}`);
	}
}

/** Resolves a chain of symbolic links (including dangling ones) to its final target. */
function symlinkTarget(path: string): string {
	let current = path;
	const seen = new Set<string>();
	for (let depth = 0; depth < 40; depth++) {
		let stats;
		try {
			stats = lstatSync(current);
		} catch {
			break; // target does not exist (dangling link) — report the path as-is
		}
		if (!stats.isSymbolicLink()) break;
		if (seen.has(current)) throw new Error(`Symlink cycle at ${path}`);
		seen.add(current);
		current = resolve(dirname(current), readlinkSync(current));
	}
	return current;
}

/**
 * Resolves a relative path inside a package. Rejects empty and absolute paths,
 * `..` segments, and symbolic links leading out of the package (including dangling ones).
 */
export function safePackagePath(root: string, relativePath: string): string {
	if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
		throw new Error(`Unsafe package path: ${relativePath}`);
	}
	const target = resolve(root, relativePath);
	assertInside(root, target);

	let current = root;
	for (const part of relative(root, target).split(sep).filter(Boolean)) {
		current = join(current, part);
		let stats;
		try {
			stats = lstatSync(current);
		} catch {
			break; // component does not exist yet — nothing to follow
		}
		if (stats.isSymbolicLink()) {
			assertInside(root, symlinkTarget(current));
		}
	}
	return target;
}

// --- registry: discovery and resolution by name/scope ---

/** Discovers skill packages of both scopes, skipping `.disabled-*` and unreadable SKILL.md files. */
export function discoverSkills(roots: SkillRoots): SkillRecord[] {
	const result: SkillRecord[] = [];
	for (const scope of ["global", "project"] as const) {
		const root = scope === "global" ? roots.globalSkills : roots.projectSkills;
		if (!existsSync(root)) continue;
		for (const directory of readdirSync(root).sort()) {
			if (directory.startsWith(".disabled-")) continue;
			const path = join(root, directory, "SKILL.md");
			if (!existsSync(path)) continue;
			try {
				const parsed = parseFrontmatter(readFileSync(path, "utf8"));
				result.push({
					name: parsed.name ?? directory,
					description: parsed.description ?? "",
					scope,
					path,
				});
			} catch {
				// Ignore unreadable entries in discovery output.
			}
		}
	}
	return result;
}

/** Resolves a skill by name; a both-scope collision requires an explicit scope. */
export function resolveSkill(roots: SkillRoots, skillName: string, requestedScope?: Scope): SkillRecord {
	const matches = discoverSkills(roots).filter(
		(skill) => skill.name === skillName && (!requestedScope || skill.scope === requestedScope),
	);
	if (matches.length === 0) throw new Error(`Skill "${skillName}" was not found`);
	if (matches.length > 1) throw new Error(`Skill "${skillName}" exists in both scopes; specify scope`);
	return matches[0];
}
