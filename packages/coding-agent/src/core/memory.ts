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

export function selectObservationSources(
	sources: SessionMessageEntry[],
	maxTokens: number = MEMORY_INPUT_MAX_TOKENS,
): { sourceEntryIds: string[]; sourceText: string } {
	const maxChars = maxTokens * 4;
	const selected: SessionMessageEntry[] = [];
	let length = 0;
	for (let index = sources.length - 1; index >= 0; index--) {
		const source = sources[index];
		const text = serializeConversation(convertToLlm([source.message]));
		const separatorLength = selected.length > 0 && text.length > 0 ? 2 : 0;
		if (selected.length > 0 && length + separatorLength + text.length > maxChars) break;
		selected.unshift(source);
		length += separatorLength + text.length;
	}
	const serialized = serializeConversation(convertToLlm(selected.map((entry) => entry.message)));
	return {
		sourceEntryIds: selected.map((entry) => entry.id),
		sourceText: serialized.length > maxChars ? serialized.slice(-maxChars) : serialized,
	};
}

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

type Reflection = { content: string; projectKind?: MemoryEntry["projectKind"] };

function parseReflections(text: string): Reflection[] {
	try {
		const reflections = (JSON.parse(text) as Record<string, unknown>).reflections;
		if (!Array.isArray(reflections)) return [];
		return reflections.flatMap((reflection): Reflection[] => {
			if (typeof reflection === "string") return [{ content: reflection }];
			if (!reflection || typeof reflection !== "object") return [];
			const { content, projectKind } = reflection as { content?: unknown; projectKind?: unknown };
			return typeof content === "string" &&
				(projectKind === undefined ||
					["convention", "decision", "failure", "procedure"].includes(projectKind as string))
				? [{ content, projectKind: projectKind as Reflection["projectKind"] }]
				: [];
		});
	} catch {
		return [];
	}
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
	const requestOptions = { apiKey: options.apiKey, headers: options.headers, env: options.env };
	const shouldObserve = sources.length > 0 && (options.force || sourceTokens >= settings.observeAfterTokens);
	let newObservations: string[] = [];
	let newTrace: string[] = [];
	let observedSourceEntryIds: string[] = [];
	let reflectionSourceEntryIds: string[] = [];
	let started = false;
	const start = () => {
		if (!started) {
			started = true;
			options.onStart?.();
		}
	};
	if (shouldObserve) {
		const { sourceEntryIds, sourceText } = selectObservationSources(sources);
		observedSourceEntryIds = sourceEntryIds;
		start();
		const observationText = await completeMemoryRequest(
			options.model,
			`Extract concise, factual observations from this session span. Preserve decision-relevant quantitative facts when present: metric, value, unit or currency, period or as-of date, source reference, valuation assumptions or results, and decisive constraints. Do not infer or invent numbers, sources, or precision. Also return compact chronological trace lines for material state changes only: scope, evidence, decisions or reversals, deliverables, and unresolved next steps. Omit routine actions. Return JSON: {"observations":["..."],"trace":["..."]}.\n\n${
				sourceEntryIds.length < sources.length ? "[Earlier transcript omitted]\n\n" : ""
			}${sourceText}`,
			requestOptions,
			options.streamFn,
		);
		if (!isCurrentBranch()) return false;
		newObservations = parseStringArray(observationText, "observations");
		newTrace = parseStringArray(observationText, "trace");
	}
	const memories = activeMemory(sessionManager.getBranch());
	const reflections: Reflection[] = [];
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
		const activeReflections = memories.filter((entry) => entry.kind === "reflection");
		const activeObservations = memories.filter((entry) => entry.kind === "observation");
		const existingReflections = activeReflections.map((entry) => `- [${entry.id}] ${entry.content}`).join("\n");
		const observations = [
			...activeObservations.map((entry) => `- [${entry.id}] ${entry.content}`),
			...newObservations.map((observation) => `- [new] ${observation}`),
		].join("\n");
		reflectionSourceEntryIds = [
			...new Set([
				...activeReflections.flatMap((entry) => entry.sourceEntryIds),
				...activeObservations.flatMap((entry) => entry.sourceEntryIds),
				...observedSourceEntryIds,
			]),
		];
		start();
		const reflectionText = await completeMemoryRequest(
			options.model,
			`Consolidate durable session facts from the evidence below. Return JSON: {"reflections":[{"content":"...","projectKind":"convention|decision|failure|procedure"}],"supersedes":["memory-entry-id"]}. Return only net-new facts or a replacement that is more specific or newer than an existing reflection. A superseded ID must appear in Existing reflections, and a returned reflection must preserve or update its fact. Do not supersede merely related facts. Include projectKind only for facts worth corroborating across sessions.\n\nExisting reflections:\n${existingReflections || "(none)"}\n\nObservations:\n${observations || "(none)"}`,
			requestOptions,
			options.streamFn,
		);
		if (!isCurrentBranch()) return false;
		reflections.push(...parseReflections(reflectionText));
		const reflectionIds = new Set(activeReflections.map((entry) => entry.id));
		reflectionSupersedes = reflections.length > 0 ? parseSupersedes(reflectionText, "supersedes", reflectionIds) : [];
	}
	for (const observation of newObservations) {
		sessionManager.appendMemory("observation", observation, observedSourceEntryIds);
	}
	for (const trace of newTrace) {
		sessionManager.appendMemory("trace", trace, observedSourceEntryIds);
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
		sessionManager.appendMemory(
			"reflection",
			reflection.content,
			reflectionSourceEntryIds,
			[],
			reflection.projectKind,
		);
	}
	if (reflectionSupersedes.length > 0) {
		sessionManager.appendMemory(
			"supersedes",
			"Superseded obsolete reflections.",
			reflectionSourceEntryIds,
			reflectionSupersedes,
		);
	}
	if (observationSupersedes.length > 0) {
		sessionManager.appendMemory(
			"supersedes",
			"Pruned stale observations.",
			observedSourceEntryIds,
			observationSupersedes,
		);
	}

	return true;
}
