// Structural egress policy: only the message fields understood by the reviewer
// are allowed to cross the model boundary.

export const EGRESS_BUDGETS = {
	messageTextBytes: 4_000,
	runBytes: 20 * 1024,
	reviewBytes: 120 * 1024,
	skillBodyBytes: 20 * 1024,
	toolOutputBytes: 50 * 1024,
} as const;

export function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = text.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return `${result}\n\n[Output truncated at ${maxBytes} bytes.]`;
}

const SECRET_PATTERNS = [
	/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
	/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g,
];
const DATA_IMAGE_PATTERN = /data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g;

function redactText(value: string): string {
	let result = value.replace(DATA_IMAGE_PATTERN, "[image removed]");
	for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[secret removed]");
	return truncateUtf8(result, EGRESS_BUDGETS.messageTextBytes);
}

const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function serializeContent(content: unknown): unknown {
	if (typeof content === "string") return redactText(content);
	if (!Array.isArray(content)) return "[unsupported content removed]";
	return content.map((part) => {
		if (!part || typeof part !== "object") return "[unsupported content removed]";
		const candidate = part as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") return { type: "text", text: redactText(candidate.text) };
		if (candidate.type === "image") return "[image removed]";
		return "[unsupported content removed]";
	});
}

function serializeMessage(message: unknown): unknown {
	if (!message || typeof message !== "object" || Array.isArray(message)) return "[unsupported message removed]";
	const candidate = message as { role?: unknown; content?: unknown };
	if (typeof candidate.role !== "string" || !MESSAGE_ROLES.has(candidate.role) || !("content" in candidate)) return "[unsupported message removed]";
	return { role: candidate.role, content: serializeContent(candidate.content) };
}

/** Serialize only the stable, reviewer-understood message shape. */
export function serializeStructuredMessages(messages: unknown[]): unknown[] {
	return messages.map(serializeMessage);
}

export function serializeRun(messages: unknown[], maxBytes = EGRESS_BUDGETS.runBytes): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(serializeStructuredMessages(messages));
	} catch {
		serialized = JSON.stringify(["[unsupported messages removed]"]);
	}
	return truncateUtf8(serialized, maxBytes);
}
