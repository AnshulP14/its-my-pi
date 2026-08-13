import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("memory settings", () => {
	it("uses a 16k observation pool and memory injection budget", () => {
		const memory = SettingsManager.inMemory().getCompactionSettings().memory;

		expect(memory.observationsPoolMaxTokens).toBe(16000);
		expect(memory.observationsPoolTargetTokens).toBe(12000);
		expect(memory.injectionMaxTokens).toBe(16000);
	});
});
