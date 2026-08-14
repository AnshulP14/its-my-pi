import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectMemory } from "../../src/core/project-memory.ts";

describe("ProjectMemory", () => {
	const paths: string[] = [];

	afterEach(() => {
		while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true });
	});

	it("promotes corroborated candidates and searches approved memory", () => {
		const dir = join(tmpdir(), `pi-project-memory-${Date.now()}-${Math.random()}`);
		paths.push(dir);
		mkdirSync(dir, { recursive: true });
		const memory = ProjectMemory.openPath(join(dir, "memory.sqlite"));
		const first = memory.addCandidate("Run npm run check after code changes.", "convention", {
			sessionId: "session-a",
			entryId: "entry-a",
			excerpt: "AGENTS.md says npm run check after code changes.",
		});
		memory.addCandidate("Run npm run check after code changes.", "convention", {
			sessionId: "session-b",
			entryId: "entry-b",
			excerpt: "The check command passed.",
		});

		expect(memory.readyCandidates()).toEqual([expect.objectContaining({ id: first.id })]);
		memory.approve(first.id, "archive");
		expect(memory.search("run check after changes")).toEqual([expect.objectContaining({ id: first.id })]);
		expect(memory.evidence(first.id)).toHaveLength(2);
		memory.close();
	});

	it("corroborates matching candidate wording with BM25", () => {
		const dir = join(tmpdir(), `pi-project-memory-${Date.now()}-${Math.random()}`);
		paths.push(dir);
		mkdirSync(dir, { recursive: true });
		const memory = ProjectMemory.openPath(join(dir, "memory.sqlite"));
		const first = memory.addCandidate("Run npm run check after code changes.", "convention", {
			sessionId: "session-a",
			entryId: "entry-a",
			excerpt: "first",
		});
		memory.addCandidate("After changing code, run npm run check.", "convention", {
			sessionId: "session-b",
			entryId: "entry-b",
			excerpt: "second",
		});

		expect(memory.readyCandidates()).toEqual([expect.objectContaining({ id: first.id })]);
		memory.close();
	});

	it("demotes and forgets approved memory", () => {
		const dir = join(tmpdir(), `pi-project-memory-${Date.now()}-${Math.random()}`);
		paths.push(dir);
		mkdirSync(dir, { recursive: true });
		const memory = ProjectMemory.openPath(join(dir, "memory.sqlite"));
		const record = memory.addCandidate("Run npm run check after code changes.", "convention", {
			sessionId: "session-a",
			entryId: "entry-a",
			excerpt: "first",
		});
		memory.approve(record.id, "core");
		memory.demote(record.id);
		expect(memory.search("npm check")).toEqual([expect.objectContaining({ tier: "archive" })]);
		memory.forget(record.id);
		expect(memory.search("npm check")).toEqual([]);
		memory.close();
	});

	it("treats FTS5 operator keywords as search terms", () => {
		const dir = join(tmpdir(), `pi-project-memory-${Date.now()}-${Math.random()}`);
		paths.push(dir);
		mkdirSync(dir, { recursive: true });
		const memory = ProjectMemory.openPath(join(dir, "memory.sqlite"));

		expect(memory.search("OR")).toEqual([]);
		memory.close();
	});
});
