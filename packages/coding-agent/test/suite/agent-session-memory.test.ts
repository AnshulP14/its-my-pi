import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

async function waitForMemory(harness: Harness): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (harness.sessionManager.getEntries().some((entry) => entry.type === "memory")) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("memory worker did not finish");
}

describe("AgentSession memory", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs the observer after a settled turn and rebuilds context with its record", async () => {
		const harness = await createHarness({
			settings: {
				compaction: {
					memory: { enabled: true, observeAfterTokens: 1, reflectAfterTokens: 100000 },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("main response"),
			fauxAssistantMessage('{"observations":["User is fixing the login redirect."]}'),
		]);

		await harness.session.prompt("Fix the login redirect.");
		await waitForMemory(harness);

		const records = harness.sessionManager.getEntries().filter((entry) => entry.type === "memory");
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "observation",
			content: "User is fixing the login redirect.",
		});
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(true);
		expect(harness.eventsOfType("memory_update_start")).toHaveLength(1);
		expect(harness.eventsOfType("memory_update_end")).toHaveLength(1);
	});

	it("flushes unprocessed memory before deterministic compaction", async () => {
		const harness = await createHarness({
			settings: {
				compaction: {
					keepRecentTokens: 1,
					memory: { enabled: true, observeAfterTokens: 100000, reflectAfterTokens: 100000 },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("main response"),
			fauxAssistantMessage('{"observations":["The redirect must preserve the return URL."]}'),
			fauxAssistantMessage('{"reflections":["Preserve return URLs in login redirects."]}'),
		]);

		await harness.session.prompt("Fix the login redirect.");
		await harness.session.compact();

		const entries = harness.sessionManager.getEntries();
		const firstMemoryIndex = entries.findIndex((entry) => entry.type === "memory");
		const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
		expect(firstMemoryIndex).toBeGreaterThanOrEqual(0);
		expect(firstMemoryIndex).toBeLessThan(compactionIndex);
		expect(entries.filter((entry) => entry.type === "memory").map((entry) => entry.kind)).toEqual([
			"observation",
			"reflection",
		]);
	});

	it("marks project-relevant reflections without changing ordinary session memory", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { memory: { enabled: true, observeAfterTokens: 1, reflectAfterTokens: 1 } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("main response"),
			fauxAssistantMessage('{"observations":["The project uses npm run check."]}'),
			fauxAssistantMessage(
				'{"reflections":[{"content":"Run npm run check after code changes.","projectKind":"convention"}]}',
			),
		]);

		await harness.session.prompt("Make a small code change.");
		for (let attempt = 0; attempt < 20; attempt++) {
			if (
				harness.sessionManager.getEntries().some((entry) => entry.type === "memory" && entry.kind === "reflection")
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "memory",
				kind: "reflection",
				projectKind: "convention",
			}),
		);
	});
});
