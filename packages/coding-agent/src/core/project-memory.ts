import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "../config.ts";

export type ProjectMemoryKind = "convention" | "decision" | "failure" | "procedure";
export type ProjectMemoryTier = "candidate" | "archive" | "core" | "forgotten";

export interface ProjectMemoryRecord {
	id: string;
	content: string;
	kind: ProjectMemoryKind;
	tier: ProjectMemoryTier;
	createdAt: string;
	lastConfirmedAt: string;
}

export interface ProjectMemoryEvidence {
	sessionId: string;
	entryId: string;
	excerpt: string;
	revision?: string;
	command?: string;
	exitCode?: number;
}

type RecordRow = ProjectMemoryRecord;

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function projectMemoryIdentity(cwd: string): { root: string; id: string } | undefined {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return undefined;
	const identity = git(root, ["remote", "get-url", "origin"]) ?? root;
	return { root, id: createHash("sha256").update(identity).digest("hex") };
}

export function projectRevision(cwd: string): string | undefined {
	return git(cwd, ["rev-parse", "HEAD"]);
}

function normalize(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function searchQuery(text: string): string | undefined {
	const terms = text.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
	return terms.length > 0 ? terms.map((term) => `"${term}"`).join(" OR ") : undefined;
}

function now(): string {
	return new Date().toISOString();
}

export class ProjectMemory {
	private readonly db: DatabaseSync;

	private constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS records (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				normalized TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL,
				tier TEXT NOT NULL,
				createdAt TEXT NOT NULL,
				lastConfirmedAt TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(id UNINDEXED, content);
			CREATE TABLE IF NOT EXISTS evidence (
				recordId TEXT NOT NULL,
				sessionId TEXT NOT NULL,
				entryId TEXT NOT NULL,
				excerpt TEXT NOT NULL,
				revision TEXT,
				command TEXT,
				exitCode INTEGER,
				PRIMARY KEY (recordId, sessionId, entryId)
			);
			CREATE TABLE IF NOT EXISTS events (at TEXT NOT NULL, recordId TEXT NOT NULL, action TEXT NOT NULL);
		`);
	}

	static open(cwd: string): ProjectMemory | undefined {
		const identity = projectMemoryIdentity(cwd);
		if (!identity) return undefined;
		const dir = join(getAgentDir(), "project-memory", identity.id);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return new ProjectMemory(join(dir, "memory.sqlite"));
	}

	static openPath(path: string): ProjectMemory {
		return new ProjectMemory(path);
	}

	close(): void {
		this.db.close();
	}

	addCandidate(content: string, kind: ProjectMemoryKind, evidence: ProjectMemoryEvidence): ProjectMemoryRecord {
		const normalized = normalize(content);
		const exact = this.db
			.prepare("SELECT id, content, kind, tier, createdAt, lastConfirmedAt FROM records WHERE normalized = ?")
			.get(normalized) as RecordRow | undefined;
		const match = searchQuery(content);
		const existing =
			exact ??
			(match
				? (this.db
						.prepare(
							"SELECT r.id, r.content, r.kind, r.tier, r.createdAt, r.lastConfirmedAt FROM record_search s JOIN records r ON r.id = s.id WHERE record_search MATCH ? AND r.tier = 'candidate' ORDER BY bm25(record_search) LIMIT 1",
						)
						.get(match) as RecordRow | undefined)
				: undefined);
		const record = existing ?? {
			id: createHash("sha256").update(`${normalized}\0${now()}`).digest("hex").slice(0, 16),
			content: content.trim(),
			kind,
			tier: "candidate" as const,
			createdAt: now(),
			lastConfirmedAt: now(),
		};
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!existing) {
				this.db
					.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)")
					.run(
						record.id,
						record.content,
						normalized,
						record.kind,
						record.tier,
						record.createdAt,
						record.lastConfirmedAt,
					);
				this.db.prepare("INSERT INTO record_search VALUES (?, ?)").run(record.id, record.content);
			}
			this.db
				.prepare("INSERT OR IGNORE INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(
					record.id,
					evidence.sessionId,
					evidence.entryId,
					evidence.excerpt.slice(0, 800),
					evidence.revision ?? null,
					evidence.command ?? null,
					evidence.exitCode ?? null,
				);
			this.db
				.prepare("INSERT INTO events VALUES (?, ?, ?)")
				.run(now(), record.id, existing ? "corroborated" : "candidate");
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return record;
	}

	readyCandidates(): ProjectMemoryRecord[] {
		return this.db
			.prepare(
				"SELECT r.id, r.content, r.kind, r.tier, r.createdAt, r.lastConfirmedAt FROM records r JOIN evidence e ON e.recordId = r.id WHERE r.tier = 'candidate' GROUP BY r.id HAVING count(DISTINCT e.sessionId) >= 2 ORDER BY r.createdAt",
			)
			.all() as unknown as RecordRow[];
	}

	approve(id: string, tier: "archive" | "core"): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("UPDATE records SET tier = ?, lastConfirmedAt = ? WHERE id = ?").run(tier, now(), id);
			this.db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(now(), id, tier);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	demote(id: string): void {
		this.approve(id, "archive");
	}

	forget(id: string): void {
		this.db.prepare("UPDATE records SET tier = ? WHERE id = ?").run("forgotten", id);
		this.db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(now(), id, "forgotten");
	}

	core(): ProjectMemoryRecord[] {
		return this.db
			.prepare(
				"SELECT id, content, kind, tier, createdAt, lastConfirmedAt FROM records WHERE tier = 'core' ORDER BY lastConfirmedAt DESC",
			)
			.all() as unknown as RecordRow[];
	}

	search(query: string, limit = 3): ProjectMemoryRecord[] {
		const match = searchQuery(query);
		if (!match) return [];
		return this.db
			.prepare(
				"SELECT r.id, r.content, r.kind, r.tier, r.createdAt, r.lastConfirmedAt FROM record_search s JOIN records r ON r.id = s.id WHERE record_search MATCH ? AND r.tier IN ('archive', 'core') ORDER BY bm25(record_search) LIMIT ?",
			)
			.all(match, limit) as unknown as RecordRow[];
	}

	records(ids: readonly string[]): ProjectMemoryRecord[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(", ");
		const found = this.db
			.prepare(
				`SELECT id, content, kind, tier, createdAt, lastConfirmedAt FROM records WHERE id IN (${placeholders})`,
			)
			.all(...ids) as unknown as RecordRow[];
		return ids.flatMap((id) => found.filter((record) => record.id === id));
	}

	evidence(id: string): ProjectMemoryEvidence[] {
		return this.db
			.prepare("SELECT sessionId, entryId, excerpt, revision, command, exitCode FROM evidence WHERE recordId = ?")
			.all(id) as unknown as ProjectMemoryEvidence[];
	}
}
