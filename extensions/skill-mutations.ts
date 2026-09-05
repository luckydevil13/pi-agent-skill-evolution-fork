// The single mutation boundary for skill packages. Callers may inspect packages,
// but writes, renames, removals, rollback, auditing and management counters live here.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ActivityStore, type ActivityPaths } from "./activity-store.ts";
import { buildSkillMd, editSkillMd, patchSkillMd } from "./skill-md-codec.ts";
import { fileHash, hashText, safePackagePath, skillDirectory, type Scope, type SkillRoots } from "./skill-package.ts";
import type { Proposal, ProposalOperation } from "./proposal-ledger.ts";

export interface SkillMutationPaths extends SkillRoots, ActivityPaths {}

const tails = new Map<string, Promise<void>>();
function queued<T>(paths: string[], work: () => T | Promise<T>): Promise<T> {
	const keys = [...new Set(paths.map((path) => resolve(path)))].sort();
	const acquire = (index: number): Promise<T> => {
		if (index === keys.length) return Promise.resolve().then(work);
		const previous = tails.get(keys[index]) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(() => acquire(index + 1));
		const tail = result.then(() => undefined, () => undefined);
		tails.set(keys[index], tail);
		void tail.then(() => { if (tails.get(keys[index]) === tail) tails.delete(keys[index]); });
		return result;
	};
	return acquire(0);
}

function root(paths: SkillMutationPaths, scope: Scope): string {
	return scope === "global" ? paths.globalSkills : paths.projectSkills;
}
function operationPath(paths: SkillMutationPaths, scope: Scope, operation: ProposalOperation): string {
	const packageRoot = skillDirectory(root(paths, scope), operation.skillName);
	return operation.type === "create" || operation.type === "edit" || operation.type === "disable"
		? join(packageRoot, "SKILL.md")
		: safePackagePath(packageRoot, operation.path);
}
function atomic(path: string, content: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", mode });
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
		throw error;
	}
}

export class SkillMutations {
	readonly paths: SkillMutationPaths;
	readonly activity: ActivityStore;

	constructor(paths: SkillMutationPaths, activity = new ActivityStore(paths)) {
		this.paths = paths;
		this.activity = activity;
	}

	/** Applies already validated operations transactionally. The callback is called before each operation. */
	async applyProposal(
		proposal: Proposal,
		beforeOperation?: (operation: ProposalOperation, index: number) => void | Promise<void>,
	): Promise<void> {
		const targets = proposal.operations.map((operation) => operationPath(this.paths, proposal.scope, operation));
		await queued(targets, async () => {
			const snapshots = new Map<string, { exists: boolean; content?: string }>();
			const createdDirs = new Set<string>();
			const renames: Array<[string, string]> = [];
			try {
				for (const [index, operation] of proposal.operations.entries()) {
					await beforeOperation?.(operation, index);
					const target = operationPath(this.paths, proposal.scope, operation);
					const packageRoot = skillDirectory(root(this.paths, proposal.scope), operation.skillName);
					if (!snapshots.has(target)) snapshots.set(target, { exists: existsSync(target), content: existsSync(target) && statSync(target).isFile() ? readFileSync(target, "utf8") : undefined });
					if (!existsSync(packageRoot)) createdDirs.add(packageRoot);
					if (operation.type === "create") {
						mkdirSync(packageRoot, { recursive: true });
						atomic(target, buildSkillMd(operation.skillName, operation.description, operation.content));
					} else if (operation.type === "edit") {
						atomic(target, editSkillMd(readFileSync(target, "utf8"), operation.description, operation.content));
					} else if (operation.type === "patch") {
						atomic(target, patchSkillMd(readFileSync(target, "utf8"), operation.find, operation.replace));
					} else if (operation.type === "write") {
						atomic(target, operation.content);
					} else {
						const disabled = join(root(this.paths, proposal.scope), `.disabled-${operation.skillName}`);
						if (existsSync(disabled)) throw new Error(`Disabled target already exists: ${disabled}`);
						renameSync(packageRoot, disabled);
						renames.push([packageRoot, disabled]);
					}
				}
			} catch (error) {
				for (const [from, to] of renames.reverse()) if (existsSync(to) && !existsSync(from)) renameSync(to, from);
				for (const [path, snapshot] of [...snapshots.entries()].reverse()) {
					if (snapshot.exists && snapshot.content !== undefined) atomic(path, snapshot.content);
					else if (!snapshot.exists && existsSync(path) && statSync(path).isFile()) unlinkSync(path);
				}
				for (const directory of createdDirs) if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
				throw error;
			}
		});
		await this.activity.recordActivity(proposal.scope, proposal.operations.map((operation) => operation.skillName), "management", undefined, {
			action: "apply-proposal", proposalId: proposal.id,
			operations: proposal.operations.map((operation) => ({ type: operation.type, skillName: operation.skillName, beforeHash: operation.beforeHash ?? null, afterHash: fileHash(operationPath(this.paths, proposal.scope, operation)) })),
		});
	}

	async bodyPatch(scope: Scope, skillName: string, find: string, replace: string): Promise<string> {
		const path = join(skillDirectory(root(this.paths, scope), skillName), "SKILL.md");
		return queued([path], async () => {
			if (!existsSync(path)) throw new Error(`Skill "${skillName}" was not found`);
			const current = readFileSync(path, "utf8");
			const next = patchSkillMd(current, find, replace);
			atomic(path, next);
			await this.activity.recordActivity(scope, skillName, "management", undefined, { action: "automatic-body-patch", skillName, beforeHash: hashText(current), afterHash: hashText(next), diff: { find, replace } });
			return path;
		});
	}

	async setEnabled(scope: Scope, skillName: string, enabled: boolean): Promise<void> {
		const active = skillDirectory(root(this.paths, scope), skillName);
		const disabled = join(root(this.paths, scope), `.disabled-${skillName}`);
		await queued([active, disabled], async () => {
			if (enabled) {
				if (!existsSync(disabled)) throw new Error(`Disabled skill "${skillName}" was not found`);
				if (existsSync(active)) throw new Error(`Active target "${skillName}" already exists`);
				renameSync(disabled, active);
			} else {
				if (!existsSync(join(active, "SKILL.md"))) throw new Error(`Active skill "${skillName}" was not found`);
				if (existsSync(disabled)) throw new Error(`Disabled skill "${skillName}" already exists`);
				renameSync(active, disabled);
			}
		});
		await this.activity.recordActivity(scope, skillName, "management", undefined, { action: enabled ? "enable" : "disable", skillName });
	}

	async purge(scope: Scope, skillName: string, confirmed: boolean): Promise<boolean> {
		if (!confirmed) return false;
		const active = skillDirectory(root(this.paths, scope), skillName);
		const disabled = join(root(this.paths, scope), `.disabled-${skillName}`);
		return queued([active, disabled], async () => {
			const target = existsSync(disabled) ? disabled : active;
			if (!existsSync(target)) throw new Error(`Skill "${skillName}" was not found`);
			rmSync(target, { recursive: true, force: true });
			await this.activity.recordActivity(scope, skillName, "management", undefined, { action: "purge", skillName });
			return true;
		});
	}

	removeLegacyStats(): boolean {
		const path = join(this.paths.globalSkills, ".skill-stats.json");
		if (!existsSync(path)) return false;
		rmSync(path, { force: true });
		return true;
	}
}

export function createSkillMutations(paths: SkillMutationPaths, activity?: ActivityStore): SkillMutations {
	return new SkillMutations(paths, activity);
}
