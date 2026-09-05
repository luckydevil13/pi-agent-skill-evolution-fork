// Activity persistence is deliberately independent from pi and typebox.
// It can be used directly by node tests and by the pi adapter.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	appendFileSync,
	mkdirSync,
	rmSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverSkills, type Scope, type SkillRoots } from "./skill-package.ts";

export type ActivityEvent = "explicitInvocation" | "skillLoad" | "management";

export interface ActivityPaths extends SkillRoots {
	globalState: string;
	projectState: string;
}

export interface SkillActivity {
	created: string;
	explicitInvocationCount: number;
	lastExplicitInvocation: string | null;
	skillLoadCount: number;
	lastSkillLoad: string | null;
	managementOperations: number;
	lastManagementOperation: string | null;
	description?: string;
}

export interface StatsFile {
	version: 2;
	reminderEnabled: boolean | null;
	lastReminderCheck: string | null;
	skills: Record<string, SkillActivity>;
}

export type AuditRecord = Record<string, unknown>;

const queueTails = new Map<string, Promise<void>>();

function stateDir(paths: ActivityPaths, scope: Scope): string {
	return scope === "global" ? paths.globalState : paths.projectState;
}

function statsPath(paths: ActivityPaths, scope: Scope): string {
	return join(stateDir(paths, scope), "stats.json");
}

function auditPath(paths: ActivityPaths, scope: Scope): string {
	return join(stateDir(paths, scope), "audit.jsonl");
}

function defaultStats(): StatsFile {
	return {
		version: 2,
		reminderEnabled: null,
		lastReminderCheck: null,
		skills: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function defaultActivity(now = new Date().toISOString()): SkillActivity {
	return {
		created: now,
		explicitInvocationCount: 0,
		lastExplicitInvocation: null,
		skillLoadCount: 0,
		lastSkillLoad: null,
		managementOperations: 0,
		lastManagementOperation: null,
	};
}

function readStatsFile(path: string): StatsFile {
	const parsed = readJson(path);
	if (!isRecord(parsed) || parsed.version !== 2) return defaultStats();

	const skills: Record<string, SkillActivity> = {};
	if (isRecord(parsed.skills)) {
		for (const [name, value] of Object.entries(parsed.skills)) {
			if (!isRecord(value)) continue;
			const fallback = defaultActivity();
			skills[name] = {
				...fallback,
				...value,
				explicitInvocationCount:
					typeof value.explicitInvocationCount === "number" ? value.explicitInvocationCount : fallback.explicitInvocationCount,
				skillLoadCount: typeof value.skillLoadCount === "number" ? value.skillLoadCount : fallback.skillLoadCount,
				managementOperations:
					typeof value.managementOperations === "number" ? value.managementOperations : fallback.managementOperations,
				lastExplicitInvocation:
					typeof value.lastExplicitInvocation === "string" ? value.lastExplicitInvocation : null,
				lastSkillLoad: typeof value.lastSkillLoad === "string" ? value.lastSkillLoad : null,
				lastManagementOperation: typeof value.lastManagementOperation === "string" ? value.lastManagementOperation : null,
				created: typeof value.created === "string" ? value.created : fallback.created,
			};
		}
	}
	return {
		version: 2,
		reminderEnabled: typeof parsed.reminderEnabled === "boolean" ? parsed.reminderEnabled : null,
		lastReminderCheck: typeof parsed.lastReminderCheck === "string" ? parsed.lastReminderCheck : null,
		skills,
	};
}

function writeTextAtomic(path: string, content: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", mode });
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// Preserve the original write/rename error.
		}
		throw error;
	}
}

function writeStatsFile(path: string, stats: StatsFile): void {
	writeTextAtomic(path, `${JSON.stringify(stats, null, 2)}\n`);
}

function withFileMutationQueue<T>(path: string, work: () => T | Promise<T>): Promise<T> {
	const key = resolve(path);
	const previous = queueTails.get(key) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(work);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	queueTails.set(key, tail);
	void tail.then(() => {
		if (queueTails.get(key) === tail) queueTails.delete(key);
	});
	return result;
}

function withFileMutationQueues<T>(paths: string[], work: () => T | Promise<T>): Promise<T> {
	const unique = [...new Set(paths.map((path) => resolve(path)))].sort();
	const acquire = (index: number): Promise<T> => {
		if (index >= unique.length) return Promise.resolve().then(work);
		return withFileMutationQueue(unique[index], () => acquire(index + 1));
	};
	return acquire(0);
}

function applyEvent(entry: SkillActivity, event: ActivityEvent, now: string): void {
	if (event === "explicitInvocation") {
		entry.explicitInvocationCount += 1;
		entry.lastExplicitInvocation = now;
	} else if (event === "skillLoad") {
		entry.skillLoadCount += 1;
		entry.lastSkillLoad = now;
	} else {
		entry.managementOperations += 1;
		entry.lastManagementOperation = now;
	}
}

/**
 * Owns all activity state files for both scopes. The optional audit record is
 * committed under the same ordered file locks as the stats update, so callers
 * do not need to coordinate stats and audit writes themselves.
 */
export class ActivityStore {
	readonly paths: ActivityPaths;

	constructor(paths: ActivityPaths) {
		this.paths = paths;
	}

	readStats(scope: Scope): StatsFile {
		return readStatsFile(statsPath(this.paths, scope));
	}

	async updateStatsFile(scope: Scope, update: (stats: StatsFile) => void | StatsFile): Promise<StatsFile> {
		const path = statsPath(this.paths, scope);
		return withFileMutationQueue(path, async () => {
			const stats = readStatsFile(path);
			const updated = update(stats) ?? stats;
			writeStatsFile(path, updated);
			return updated;
		});
	}

	async recordActivity(
		scope: Scope,
		skillNames: string | string[],
		event: ActivityEvent,
		description?: string,
		audit?: AuditRecord,
	): Promise<void> {
		const names = Array.isArray(skillNames) ? skillNames : [skillNames];
		const statsFile = statsPath(this.paths, scope);
		const files = audit ? [statsFile, auditPath(this.paths, scope)] : [statsFile];
		await withFileMutationQueues(files, async () => {
			const stats = readStatsFile(statsFile);
			const now = new Date().toISOString();
			for (const skillName of names) {
				const entry = stats.skills[skillName] ?? defaultActivity(now);
				applyEvent(entry, event, now);
				if (description) entry.description = description;
				stats.skills[skillName] = entry;
			}
			writeStatsFile(statsFile, stats);
			if (audit) this.appendAuditLocked(scope, audit);
		});
	}

	async appendAudit(scope: Scope, record: AuditRecord): Promise<void> {
		await withFileMutationQueue(auditPath(this.paths, scope), () => {
			this.appendAuditLocked(scope, record);
		});
	}

	inactiveSkills(scope: Scope, inactiveDays: number): string[] {
		const stats = this.readStats(scope);
		const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;
		return discoverSkills(this.paths)
			.filter((skill) => skill.scope === scope)
			.filter((skill) => {
				const entry = stats.skills[skill.name];
				if (!entry) return statSync(skill.path).mtimeMs < cutoff;
				const dates = [entry.lastExplicitInvocation, entry.lastSkillLoad]
					.filter((date): date is string => Boolean(date))
					.map((date) => new Date(date).getTime())
					.filter(Number.isFinite);
				const lastActivity = dates.length ? Math.max(...dates) : 0;
				return lastActivity < cutoff;
			})
			.map((skill) => skill.name)
			.sort();
	}

	removeLegacyStats(): boolean {
		const path = join(this.paths.globalSkills, ".skill-stats.json");
		if (!existsSync(path)) return false;
		rmSync(path, { force: true });
		return true;
	}

	private appendAuditLocked(scope: Scope, record: AuditRecord): void {
		const path = auditPath(this.paths, scope);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ...record, timestamp: new Date().toISOString() })}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
}

// Functional adapters keep the module convenient for callers that do not need
// to retain a store instance, while all behavior still lives in ActivityStore.
export function readStats(paths: ActivityPaths, scope: Scope): StatsFile {
	return new ActivityStore(paths).readStats(scope);
}

export function updateStats(
	paths: ActivityPaths,
	scope: Scope,
	skillNames: string | string[],
	event: ActivityEvent,
	description?: string,
	audit?: AuditRecord,
): Promise<void> {
	return new ActivityStore(paths).recordActivity(scope, skillNames, event, description, audit);
}

export function appendAudit(paths: ActivityPaths, scope: Scope, record: AuditRecord): Promise<void> {
	return new ActivityStore(paths).appendAudit(scope, record);
}

export function inactiveSkills(paths: ActivityPaths, scope: Scope, inactiveDays: number): string[] {
	return new ActivityStore(paths).inactiveSkills(scope, inactiveDays);
}

export function removeLegacyStats(paths: ActivityPaths): boolean {
	return new ActivityStore(paths).removeLegacyStats();
}
