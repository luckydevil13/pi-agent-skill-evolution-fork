// Proposal lifecycle and transactional application. This module deliberately has
// no runtime dependency on pi or typebox.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ActivityStore, type ActivityPaths } from "./activity-store.ts";
import {
	fileHash,
	safePackagePath,
	skillDirectory,
	type Scope,
	type SkillRoots,
	discoverSkills,
	validateSkillName,
} from "./skill-package.ts";
import { buildSkillMd, editSkillMd, patchSkillMd } from "./skill-md-codec.ts";

export type ProposalStatus = "pending" | "applied" | "rejected" | "stale";
export type ProposalOperation =
	| { type: "create"; skillName: string; description: string; content: string; beforeHash?: string | null }
	| { type: "edit"; skillName: string; description?: string; content: string; beforeHash?: string | null }
	| { type: "patch"; skillName: string; path: string; find: string; replace: string; beforeHash?: string | null }
	| { type: "write"; skillName: string; path: string; content: string; beforeHash?: string | null }
	| { type: "disable"; skillName: string; beforeHash?: string | null };

export interface Proposal {
	version: 1;
	id: string;
	title: string;
	rationale: string;
	scope: Scope;
	status: ProposalStatus;
	createdAt: string;
	updatedAt: string;
	operations: ProposalOperation[];
}

export type ProposalDraft = Pick<Proposal, "title" | "rationale" | "scope"> & {
	operations: ProposalOperation[];
};

export interface ProposalLedgerPaths extends SkillRoots, ActivityPaths {}
export interface ProposalLedgerOptions {
	/** Test hook, called immediately before each operation is executed. */
	onOperation?: (operation: ProposalOperation, index: number) => void | Promise<void>;
}

function stateDir(paths: ProposalLedgerPaths, scope: Scope): string {
	return scope === "global" ? paths.globalState : paths.projectState;
}
function skillsDir(paths: ProposalLedgerPaths, scope: Scope): string {
	return scope === "global" ? paths.globalSkills : paths.projectSkills;
}
function proposalPath(paths: ProposalLedgerPaths, scope: Scope, id: string): string {
	return join(stateDir(paths, scope), "proposals", `${id}.json`);
}
function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* preserve original error */ }
		throw error;
	}
}
function writeProposal(path: string, proposal: Proposal): void {
	atomicWrite(path, `${JSON.stringify(proposal, null, 2)}\n`);
}
function readProposal(path: string): Proposal {
	const proposal = JSON.parse(readFileSync(path, "utf8")) as Proposal;
	if (proposal.version !== 1 || !proposal.id || !Array.isArray(proposal.operations)) throw new Error(`Invalid proposal file: ${path}`);
	return proposal;
}

export class ProposalLedger {
	readonly paths: ProposalLedgerPaths;
	readonly activity: ActivityStore;
	readonly options: ProposalLedgerOptions;

	constructor(paths: ProposalLedgerPaths, options: ProposalLedgerOptions = {}) {
		this.paths = paths;
		this.activity = new ActivityStore(paths);
		this.options = options;
	}

	list(scope?: Scope): Proposal[] {
		const scopes = scope ? [scope] : (["global", "project"] as const);
		return scopes.flatMap((item) => {
			const dir = join(stateDir(this.paths, item), "proposals");
			if (!existsSync(dir)) return [];
			return readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
				try { return [readProposal(join(dir, name))]; } catch { return []; }
			});
		}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	find(id: string, scope?: Scope): Proposal {
		const matches = this.list(scope).filter((proposal) => proposal.id === id);
		if (matches.length === 0) throw new Error(`Proposal "${id}" was not found`);
		if (matches.length > 1) throw new Error(`Proposal ID "${id}" is ambiguous`);
		return matches[0];
	}

	async save(draft: ProposalDraft): Promise<Proposal> {
		this.validateDraft(draft);
		const operations = draft.operations.map((operation) => ({ ...operation, beforeHash: this.hashFor(draft.scope, operation) }));
		const duplicate = this.list(draft.scope).find((proposal) =>
			proposal.status === "pending" && JSON.stringify(proposal.operations) === JSON.stringify(operations));
		if (duplicate) return duplicate;
		const now = new Date().toISOString();
		const proposal: Proposal = { version: 1, id: randomUUID(), title: draft.title, rationale: draft.rationale,
			scope: draft.scope, status: "pending", createdAt: now, updatedAt: now, operations };
		writeProposal(proposalPath(this.paths, proposal.scope, proposal.id), proposal);
		return proposal;
	}

	async apply(proposalOrId: Proposal | string, scope?: Scope): Promise<void> {
		const proposal = typeof proposalOrId === "string" ? this.find(proposalOrId, scope) : proposalOrId;
		if (proposal.status !== "pending") throw new Error(`Proposal is ${proposal.status}, not pending`);
		const path = proposalPath(this.paths, proposal.scope, proposal.id);
		this.assertFresh(proposal);
		const snapshots = new Map<string, { exists: boolean; content?: string }>();
		const createdDirs = new Set<string>();
		const renames: Array<[string, string]> = [];
		try {
			this.validateOperations(proposal.scope, proposal.operations);
			for (const [index, operation] of proposal.operations.entries()) {
				await this.options.onOperation?.(operation, index);
				const target = this.operationPath(proposal.scope, operation);
				if (!snapshots.has(target)) snapshots.set(target, { exists: existsSync(target), content: existsSync(target) && statSync(target).isFile() ? readFileSync(target, "utf8") : undefined });
				const root = skillDirectory(skillsDir(this.paths, proposal.scope), operation.skillName);
				if (!existsSync(root)) createdDirs.add(root);
				if (operation.type === "create") {
					mkdirSync(root, { recursive: true });
					atomicWrite(target, buildSkillMd(operation.skillName, operation.description, operation.content));
				} else if (operation.type === "edit") {
					atomicWrite(target, editSkillMd(readFileSync(target, "utf8"), operation.description, operation.content));
				} else if (operation.type === "patch") {
					atomicWrite(target, patchSkillMd(readFileSync(target, "utf8"), operation.find, operation.replace));
				} else if (operation.type === "write") {
					mkdirSync(dirname(target), { recursive: true });
					atomicWrite(target, operation.content);
				} else {
					const disabled = join(skillsDir(this.paths, proposal.scope), `.disabled-${operation.skillName}`);
					if (existsSync(disabled)) throw new Error(`Disabled target already exists: ${disabled}`);
					renameSync(root, disabled);
					renames.push([root, disabled]);
				}
			}
			proposal.status = "applied";
			proposal.updatedAt = new Date().toISOString();
			writeProposal(path, proposal);
		} catch (error) {
			for (const [from, to] of renames.reverse()) {
				if (existsSync(to) && !existsSync(from)) renameSync(to, from);
			}
			for (const [target, snapshot] of [...snapshots.entries()].reverse()) {
				if (snapshot.exists && snapshot.content !== undefined) atomicWrite(target, snapshot.content);
				else if (!snapshot.exists && existsSync(target) && statSync(target).isFile()) unlinkSync(target);
			}
			for (const directory of createdDirs) if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
			throw error;
		}
		await this.activity.recordActivity(proposal.scope, proposal.operations.map((operation) => operation.skillName), "management", undefined, {
			action: "apply-proposal", proposalId: proposal.id,
			operations: proposal.operations.map((operation) => ({ type: operation.type, skillName: operation.skillName, beforeHash: operation.beforeHash ?? null, afterHash: fileHash(this.operationPath(proposal.scope, operation)) })),
		});
	}

	async reject(proposalOrId: Proposal | string, scope?: Scope): Promise<Proposal> {
		const proposal = typeof proposalOrId === "string" ? this.find(proposalOrId, scope) : proposalOrId;
		if (proposal.status !== "pending") throw new Error(`Proposal is ${proposal.status}`);
		proposal.status = "rejected"; proposal.updatedAt = new Date().toISOString();
		writeProposal(proposalPath(this.paths, proposal.scope, proposal.id), proposal);
		return proposal;
	}

	rotate(maxAgeDays: number, now = Date.now()): number {
		const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
		let removed = 0;
		for (const proposal of this.list()) if (proposal.status !== "pending" && new Date(proposal.updatedAt).getTime() < cutoff) {
			unlinkSync(proposalPath(this.paths, proposal.scope, proposal.id)); removed++;
		}
		return removed;
	}

	private validateDraft(draft: ProposalDraft): void {
		if (draft.scope !== "global" && draft.scope !== "project") throw new Error("Proposal has invalid scope");
		if (!draft.operations?.length) throw new Error("Proposal has no operations");
		const names = new Set<string>();
		const creates = new Set(draft.operations.filter((operation) => operation.type === "create").map((operation) => operation.skillName));
		for (const operation of draft.operations) {
			const error = validateSkillName(operation.skillName); if (error) throw new Error(error);
			if (names.has(operation.skillName) && operation.type === "create") throw new Error(`Skill name "${operation.skillName}" is created more than once`);
			names.add(operation.skillName);
			if (operation.type === "create") {
				if (!operation.description.trim()) throw new Error("Create requires a description");
				if (!operation.content.trim()) throw new Error("Create requires a non-empty body");
				if (discoverSkills(this.paths).some((skill) => skill.name === operation.skillName)) throw new Error(`Skill name "${operation.skillName}" already exists`);
			} else if (!creates.has(operation.skillName) && !existsSync(join(skillDirectory(skillsDir(this.paths, draft.scope), operation.skillName), "SKILL.md"))) {
				throw new Error(`Skill "${operation.skillName}" has no SKILL.md`);
			}
		}
	}

	private validateOperations(scope: Scope, operations: ProposalOperation[]): void {
		const created = new Set(operations.filter((operation) => operation.type === "create").map((operation) => operation.skillName));
		for (const operation of operations) {
			if (operation.type === "create") {
				if (!operation.description.trim()) throw new Error("Create requires a description");
				if (!operation.content.trim()) throw new Error("Create requires a non-empty body");
				if (discoverSkills(this.paths).some((skill) => skill.name === operation.skillName && skill.scope === scope)) throw new Error(`Skill name "${operation.skillName}" already exists in ${scope} scope`);
			} else if (!existsSync(join(skillDirectory(skillsDir(this.paths, scope), operation.skillName), "SKILL.md")) && !created.has(operation.skillName)) {
				throw new Error(`Skill "${operation.skillName}" has no SKILL.md`);
			} else if (operation.type === "edit" && !operation.content.trim()) throw new Error("Edit requires a non-empty body");
			else if (operation.type === "patch" && !operation.find) throw new Error("Patch requires non-empty find text");
		}
	}

	private operationPath(scope: Scope, operation: ProposalOperation): string {
		const root = skillDirectory(skillsDir(this.paths, scope), operation.skillName);
		return operation.type === "create" || operation.type === "edit" || operation.type === "disable" ? join(root, "SKILL.md") : safePackagePath(root, operation.path);
	}
	private hashFor(scope: Scope, operation: ProposalOperation): string | null { return fileHash(this.operationPath(scope, operation)); }
	private assertFresh(proposal: Proposal): void {
		for (const operation of proposal.operations) if (this.hashFor(proposal.scope, operation) !== (operation.beforeHash ?? null)) {
			proposal.status = "stale"; proposal.updatedAt = new Date().toISOString();
			writeProposal(proposalPath(this.paths, proposal.scope, proposal.id), proposal);
			throw new Error(`Proposal is stale for ${operation.skillName} (${operation.type})`);
		}
	}
}

export function createProposalLedger(paths: ProposalLedgerPaths, options?: ProposalLedgerOptions): ProposalLedger {
	return new ProposalLedger(paths, options);
}
