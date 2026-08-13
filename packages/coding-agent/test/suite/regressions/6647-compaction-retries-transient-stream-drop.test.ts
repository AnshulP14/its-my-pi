import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("#6647 deterministic compaction avoids summary stream retries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function seedCompactableSession(harness: Harness): void {
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			...fauxAssistantMessage("assistant response to compact", { stopReason: "stop", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	it("compacts successfully without a summary request or retry events", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);

		const result = await harness.session.compact();

		expect(result.summary).toContain("message to compact");
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
	});
});
