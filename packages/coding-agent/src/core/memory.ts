import type { StreamFn } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSummarization, estimateTokens } from "./compaction/index.ts";
import { serializeConversation } from "./compaction/utils.ts";
import { convertToLlm } from "./messages.ts";
import type { MemoryEntry, SessionEntry, SessionManager, SessionMessageEntry } from "./session-manager.ts";
import type { MemorySettings } from "./settings-manager.ts";

const MEMORY_SYSTEM_PROMPT =
	"Extract session memory. Return only the requested JSON. Do not continue the conversation.";
const MEMORY_INPUT_MAX_TOKENS = 32768;

function parseStringArray(text: string, key: string): string[] {
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		const records = value[key];
		return Array.isArray(records) ? records.filter((record): record is string => typeof record === "string") : [];
	} catch {
		return [];
	}
}

function parseSupersedes(text: string, key: string, validIds: Set<string>): string[] {
	return parseStringArray(text, key).filter((id) => validIds.has(id));
}

function activeMemory(entries: SessionEntry[]): MemoryEntry[] {
	const memory = entries.filter((entry): entry is MemoryEntry => entry.type === "memory");
	const superseded = new Set(memory.flatMap((entry) => (entry.kind === "supersedes" ? entry.supersedes : [])));
	return memory.filter((entry) => entry.kind !== "supersedes" && !superseded.has(entry.id));
}

function unprocessedMessages(entries: SessionEntry[]): SessionMessageEntry[] {
	const processed = new Set(
		entries.filter((entry): entry is MemoryEntry => entry.type === "memory").flatMap((entry) => entry.sourceEntryIds),
	);
	return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message" && !processed.has(entry.id));
}

async function completeMemoryRequest(
	model: Model<Api>,
	prompt: string,
	options: Omit<SimpleStreamOptions, "maxTokens">,
	streamFn: StreamFn | undefined,
): Promise<string> {
	const response = await completeSummarization(
		model,
		{
			systemPrompt: MEMORY_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{ ...options, maxTokens: model.maxTokens > 0 ? Math.min(2048, model.maxTokens) : 2048 },
		streamFn,
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Memory request failed");
	}
	return contentText(response.content);
}

export interface MemoryRunOptions {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	streamFn?: StreamFn;
	force?: boolean;
	isCurrentBranch?: () => boolean;
	onStart?: () => void;
}

/**
 * Persist observations, reflections, and pruning decisions for the active branch.
 * Callers decide whether failures should be surfaced or deferred.
 */
export async function updateSessionMemory(
	sessionManager: SessionManager,
	settings: Required<MemorySettings>,
	options: MemoryRunOptions,
): Promise<boolean> {
	if (!settings.enabled) return false;
	const isCurrentBranch = options.isCurrentBranch ?? (() => true);

	const branch = sessionManager.getBranch();
	const sources = unprocessedMessages(branch);
	const sourceTokens = sources.reduce(
		(total, entry) => total + (entry.type === "message" ? estimateTokens(entry.message) : 0),
		0,
	);
	const sourceEntryIds = sources.map((entry) => entry.id);
	const requestOptions = { apiKey: options.apiKey, headers: options.headers, env: options.env };
	const shouldObserve = sources.length > 0 && (options.force || sourceTokens >= settings.observeAfterTokens);
	let newObservations: string[] = [];
	let started = false;
	const start = () => {
		if (!started) {
			started = true;
			options.onStart?.();
		}
	};
	if (shouldObserve) {
		const serializedSources = serializeConversation(convertToLlm(sources.map((entry) => entry.message)));
		const sourceText = serializedSources.slice(-MEMORY_INPUT_MAX_TOKENS * 4);
		start();
		const observationText = await completeMemoryRequest(
			options.model,
			`Extract concise, factual observations from this session span. Return JSON: {"observations":["..."]}.\n\n${
				sourceText.length < serializedSources.length ? "[Earlier transcript omitted]\n\n" : ""
			}${sourceText}`,
			requestOptions,
			options.streamFn,
		);
		if (!isCurrentBranch()) return false;
		newObservations = parseStringArray(observationText, "observations");
	}
	const memories = activeMemory(sessionManager.getBranch());
	const reflections: string[] = [];
	let reflectionSupersedes: string[] = [];
	let observationSupersedes: string[] = [];

	const reflectedSourceIds = new Set(
		memories.filter((entry) => entry.kind === "reflection").flatMap((entry) => entry.sourceEntryIds),
	);
	const reflectionTokens = branch
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && !reflectedSourceIds.has(entry.id))
		.reduce((total, entry) => total + estimateTokens(entry.message), 0);
	const shouldReflect =
		(memories.length > 0 || newObservations.length > 0) &&
		(options.force || reflectionTokens >= settings.reflectAfterTokens);
	if (shouldReflect) {
		const observations = memories
			.filter((entry) => entry.kind === "observation")
			.map((entry) => entry.content)
			.concat(newObservations)
			.map((observation) => `- ${observation}`)
			.join("\n");
		start();
		const reflectionText = await completeMemoryRequest(
			options.model,
			`Consolidate durable session facts from these observations. Return JSON: {"reflections":["..."],"supersedes":["memory-entry-id"]}. Supersede only obsolete reflections.\n\n${observations}`,
			requestOptions,
			options.streamFn,
		);
		if (!isCurrentBranch()) return false;
		reflections.push(...parseStringArray(reflectionText, "reflections"));
		const reflectionIds = new Set(memories.filter((entry) => entry.kind === "reflection").map((entry) => entry.id));
		reflectionSupersedes = parseSupersedes(reflectionText, "supersedes", reflectionIds);
	}

	for (const observation of newObservations) {
		sessionManager.appendMemory("observation", observation, sourceEntryIds);
	}
	const observations = activeMemory(sessionManager.getBranch()).filter((entry) => entry.kind === "observation");
	const observationTokens = observations.reduce((total, entry) => total + Math.ceil(entry.content.length / 4), 0);
	if (observationTokens > settings.observationsPoolMaxTokens) {
		const observationList = observations.map((entry) => `- ${entry.id}: ${entry.content}`).join("\n");
		start();
		const dropperText = await completeMemoryRequest(
			options.model,
			`Drop stale or redundant observations until the retained pool is about ${settings.observationsPoolTargetTokens} tokens. Return JSON: {"supersedes":["memory-entry-id"]}.\n\n${observationList}`,
			requestOptions,
			options.streamFn,
		);
		if (!isCurrentBranch()) return false;
		observationSupersedes = parseSupersedes(
			dropperText,
			"supersedes",
			new Set(observations.map((entry) => entry.id)),
		);
	}

	for (const reflection of reflections) {
		sessionManager.appendMemory("reflection", reflection, sourceEntryIds);
	}
	if (reflectionSupersedes.length > 0) {
		sessionManager.appendMemory(
			"supersedes",
			"Superseded obsolete reflections.",
			sourceEntryIds,
			reflectionSupersedes,
		);
	}
	if (observationSupersedes.length > 0) {
		sessionManager.appendMemory("supersedes", "Pruned stale observations.", sourceEntryIds, observationSupersedes);
	}

	return true;
}
