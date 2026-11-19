// omp provider that drives the official `claude` CLI (Claude Code) in headless mode.
//
// Compliance design (keep these when editing):
// - Auth is whatever `claude` itself is logged into. This file never reads, copies or
//   forwards OAuth/API credentials and never talks to api.anthropic.com directly.
// - Only the documented headless interface is used: `claude -p --output-format stream-json`
//   (https://code.claude.com/docs/en/cli-reference, Agent SDK "headless").
// - Anthropic env credentials/routing vars are stripped from the child so a stray
//   ANTHROPIC_API_KEY / gateway URL cannot silently change how the request is billed.
// - One user prompt = one child process. No retry loops, no background polling,
//   bounded concurrency. A rate-limit rejection is surfaced as an error, not retried.
// - The child owns its tool loop (Read/Edit/Bash...). omp tools are not exposed to it.
// - Usage stays ordinary and individual (guardrails below): only the main conversation is
//   served, background roles may not use this provider, cache warming never spawns a run,
//   and unattended chains (goal/loop modes, subagents) pause after a fixed number of runs.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

const PROVIDER = "cc";
const API = "cc-cli";
// Roles that are the user's own conversation. Every other role (smol, commit, judge, task,
// vision, ...) is background work omp starts by itself, so it must use another provider.
const INTERACTIVE_ROLES = new Set(["default", "plan", "slow"]);
const requestedUnattended = Number(process.env.OMP_CC_MAX_UNATTENDED_RUNS ?? 20);
const MAX_UNATTENDED_RUNS =
	Number.isInteger(requestedUnattended) && requestedUnattended > 0 ? requestedUnattended : 20;
// Runs started since the user last typed something. Module-level, so subagents share it.
let runsSinceUserInput = 0;
let readRoles: () => Record<string, string> = () => ({});
const CLAUDE_BIN = process.env.OMP_CC_BIN ?? "claude";
// acceptEdits: file edits allowed, other tools only if already allowed in Claude settings.
// Headless mode cannot prompt, so anything else is denied rather than silently approved.
const PERMISSION_MODE = process.env.OMP_CC_PERMISSION_MODE ?? "acceptEdits";
const requestedConcurrency = Number(process.env.OMP_CC_MAX_CONCURRENT ?? 1);
// A typo here (NaN) would otherwise disable the cap entirely.
const MAX_CONCURRENT = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1;
// Claude Code already retries transient API failures itself. omp's session retries any
// error whose text matches wording like this, which would re-launch `claude` against a
// spent plan, so such details are logged instead of shown in the error text.
const RETRY_BAIT = /limit|rate|quota|usage|overload|capacity|time.?out|terminat|unavailable|server|internal|network|connect|socket|fetch|retry|stall|\b(?:4\d\d|5\d\d)\b/i;
let logger: ExtensionAPI["logger"] | undefined;
const STRIPPED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_OAUTH"];

// Claude Code has no model-list command, so this table is static.
// Source: https://code.claude.com/docs/en/model-config (effort levels, 1M windows).
// shortcut: hardcoded table, refresh when Anthropic ships a model.
const EFFORTS_FULL = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORTS_NO_XHIGH = ["low", "medium", "high", "max"] as const;
const WINDOW_1M = 1_000_000;
const WINDOW_200K = 200_000;

type Spec = {
	id: string;
	name: string;
	efforts: readonly string[];
	defaultLevel: string;
	contextWindow: number;
};
const SPECS: Spec[] = [
	// Aliases follow whatever the CLI resolves them to (currently the 5.5 family).
	{ id: "fable", name: "Fable (latest)", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "opus", name: "Opus (latest)", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "sonnet", name: "Sonnet (latest)", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "haiku", name: "Haiku (latest)", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	// Pinned versions.
	{ id: "claude-fable-5-2", name: "Fable 5.2", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "claude-opus-5-5", name: "Opus 5.5", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "claude-haiku-5-5", name: "Haiku 5.5", efforts: EFFORTS_FULL, defaultLevel: "medium", contextWindow: WINDOW_1M },
	{ id: "claude-opus-5", name: "Opus 5", efforts: EFFORTS_FULL, defaultLevel: "high", contextWindow: WINDOW_1M },
	{ id: "claude-sonnet-5", name: "Sonnet 5", efforts: EFFORTS_FULL, defaultLevel: "high", contextWindow: WINDOW_1M },
	{ id: "claude-opus-4-8", name: "Opus 4.8", efforts: EFFORTS_FULL, defaultLevel: "high", contextWindow: WINDOW_1M },
	{ id: "claude-opus-4-7", name: "Opus 4.7", efforts: EFFORTS_FULL, defaultLevel: "xhigh", contextWindow: WINDOW_1M },
	{ id: "claude-opus-4-6", name: "Opus 4.6", efforts: EFFORTS_NO_XHIGH, defaultLevel: "high", contextWindow: WINDOW_200K },
	{ id: "claude-sonnet-4-6", name: "Sonnet 4.6", efforts: EFFORTS_NO_XHIGH, defaultLevel: "high", contextWindow: WINDOW_200K },
];

const MODELS = SPECS.map((s) => ({
	id: s.id,
	name: `${s.name} (claude CLI)`,
	reasoning: true,
	thinking: { mode: "effort", efforts: [...s.efforts], defaultLevel: s.defaultLevel } as any,
	input: ["text"] as ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // plan-billed, not per token
	contextWindow: s.contextWindow,
	maxTokens: 32000,
}));

// omp session id -> Claude Code session. In-memory: after an omp restart the first turn
// starts a fresh Claude session and replays the transcript as text.
const sessions = new Map<string, { claudeId: string; started: boolean }>();

let running = 0;
const waiters: Array<() => void> = [];
async function acquire(signal?: AbortSignal): Promise<void> {
	while (running >= MAX_CONCURRENT) {
		if (signal?.aborted) throw new Error("aborted");
		await new Promise<void>((resolve) => waiters.push(resolve));
	}
	running++;
}
function release(): void {
	running--;
	waiters.shift()?.();
}

type Block = { type: string; text?: string; content?: unknown };
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image omitted]" : ""))
		.join("\n");
}

// shortcut: replay is plain text without tool calls, fine for resuming a chat; upgrade if exact fidelity matters.
function buildPrompt(messages: any[], resuming: boolean): string {
	const last = messages.at(-1);
	if (resuming || messages.length <= 1) return textOf(last?.content);
	const history = messages
		.slice(0, -1)
		.filter((m) => m.role === "user" || m.role === "assistant")
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m.content)}`)
		.join("\n\n");
	return `Earlier conversation (context only):\n${history}\n\nCurrent request:\n${textOf(last?.content)}`;
}

function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!STRIPPED_ENV_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
	}
	return env;
}

function emptyMessage(model: any): any {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider: PROVIDER,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// Returns why this request must not start a `claude` run, or undefined when it may.
// Messages avoid retry wording (see RETRY_BAIT) so omp does not re-send them.
function guardrailRefusal(options: any): string | undefined {
	const backgroundRoles = Object.entries(readRoles())
		.filter(([role, model]) => !INTERACTIVE_ROLES.has(role) && String(model).startsWith(`${PROVIDER}/`))
		.map(([role]) => role);
	if (backgroundRoles.length > 0) {
		return `The ${PROVIDER} provider is off while background roles point at it (${backgroundRoles.join(", ")}). Set those roles to another provider in config.yml; only default, plan and slow may use ${PROVIDER}.`;
	}
	if (options?.parentSessionId) {
		return `The ${PROVIDER} provider only answers your own conversation, not omp side requests. Use another provider for that feature.`;
	}
	if (runsSinceUserInput >= MAX_UNATTENDED_RUNS) {
		return `Paused: ${runsSinceUserInput} claude runs since your last message. Send a message to continue (cap: OMP_CC_MAX_UNATTENDED_RUNS).`;
	}
	return undefined;
}

async function run(stream: AssistantMessageEventStream, model: any, context: any, options: any): Promise<void> {
	const out = emptyMessage(model);
	const fail = (reason: "error" | "aborted", message: string) => {
		out.stopReason = reason;
		out.errorMessage = message;
		stream.push({ type: "error", reason, error: out });
		stream.end();
	};

	// Cache pre-warm: answering it would spawn a full `claude` run for nothing.
	if (options?.prewarm) {
		out.stopReason = "length";
		stream.push({ type: "start", partial: out });
		stream.push({ type: "done", reason: "length", message: out });
		stream.end();
		return;
	}
	const refusal = guardrailRefusal(options);
	if (refusal) return fail("error", refusal);

	try {
		await acquire(options?.signal);
	} catch {
		return fail("aborted", "aborted before start");
	}
	runsSinceUserInput++;

	const sessionKey: string = options?.sessionId ?? "default";
	let session = sessions.get(sessionKey);
	const resuming = !!session?.started;
	if (!session) {
		session = { claudeId: randomUUID(), started: false };
		sessions.set(sessionKey, session);
	}

	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		model.id,
		"--permission-mode",
		PERMISSION_MODE,
		...(resuming ? ["--resume", session.claudeId] : ["--session-id", session.claudeId]),
	];
	if (options?.reasoning) args.push("--effort", options.reasoning === "minimal" ? "low" : options.reasoning);

	const child = spawn(CLAUDE_BIN, args, { cwd: options?.cwd ?? process.cwd(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
	const onAbort = () => child.kill("SIGTERM");
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	stream.push({ type: "start", partial: out });
	child.stdin.end(buildPrompt(context.messages, resuming));

	// Claude block key "<messageId>:<index>" -> omp content index.
	const blockMap = new Map<string, { idx: number; kind: "text" | "thinking" | "tool"; json: string; name?: string }>();
	let stderr = "";
	let resultEvent: any;
	let planResetsAt: number | undefined;
	child.stderr.on("data", (d) => (stderr += d));

	const handle = (ev: any) => {
		if (ev.type === "result") resultEvent = ev;
		if (ev.type === "rate_limit_event" && ev.rate_limit_info?.status === "rejected") {
			planResetsAt = ev.rate_limit_info.resetsAt;
		}
		if (ev.type !== "stream_event") return;
		const e = ev.event;
		const key = `${ev.api_message_id ?? ""}:${e.index}`;
		if (e.type === "content_block_start") {
			const t = e.content_block.type;
			const kind = t === "text" ? "text" : t === "thinking" || t === "redacted_thinking" ? "thinking" : "tool";
			const idx = out.content.length;
			out.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			blockMap.set(key, { idx, kind, json: "", name: e.content_block.name });
			stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: idx, partial: out } as any);
		} else if (e.type === "content_block_delta") {
			const b = blockMap.get(key);
			if (!b) return;
			const d = e.delta;
			if (d.type === "text_delta") {
				out.content[b.idx].text += d.text;
				stream.push({ type: "text_delta", contentIndex: b.idx, delta: d.text, partial: out });
			} else if (d.type === "thinking_delta") {
				out.content[b.idx].thinking += d.thinking;
				stream.push({ type: "thinking_delta", contentIndex: b.idx, delta: d.thinking, partial: out });
			} else if (d.type === "input_json_delta") {
				b.json += d.partial_json;
			}
		} else if (e.type === "content_block_stop") {
			const b = blockMap.get(key);
			if (!b) return;
			if (b.kind === "tool") {
				// Child-owned tool call: shown as a status line, never emitted as an omp toolCall.
				const line = `▸ ${b.name}${b.json ? ` ${b.json.slice(0, 160)}` : ""}`;
				out.content[b.idx].thinking = line;
				stream.push({ type: "thinking_delta", contentIndex: b.idx, delta: line, partial: out });
			}
			const content = b.kind === "text" ? out.content[b.idx].text : out.content[b.idx].thinking;
			stream.push({ type: b.kind === "text" ? "text_end" : "thinking_end", contentIndex: b.idx, content, partial: out } as any);
			blockMap.delete(key);
		}
	};

	let buf = "";
	child.stdout.on("data", (chunk) => {
		buf += chunk;
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			try {
				handle(JSON.parse(line));
			} catch (err) {
				if (!(err instanceof SyntaxError)) throw err; // non-JSON noise on stdout is ignored
			}
		}
	});

	const code: number | null = await new Promise((resolve) => {
		child.on("error", (err) => {
			stderr += String(err);
			resolve(-1);
		});
		child.on("close", resolve);
	});
	options?.signal?.removeEventListener("abort", onAbort);
	release();

	if (options?.signal?.aborted) return fail("aborted", "aborted");
	if (code !== 0 || resultEvent?.is_error) {
		const detail = String(resultEvent?.result ?? stderr.trim() ?? "").slice(0, 2000);
		logger?.warn?.("cc driver: claude run failed", { exitCode: code, detail });
		if (planResetsAt) {
			const when = new Date(planResetsAt * 1000).toLocaleString();
			return fail("error", `Claude plan allowance spent; it resets ${when}. The cc driver does not re-send.`);
		}
		const shown = detail && !RETRY_BAIT.test(detail) ? detail : "details are in the omp log";
		return fail("error", `claude stopped (exit ${code}): ${shown}. The cc driver does not re-send.`);
	}

	session.started = true;
	const u = resultEvent?.usage ?? {};
	out.usage.input = u.input_tokens ?? 0;
	out.usage.output = u.output_tokens ?? 0;
	out.usage.cacheRead = u.cache_read_input_tokens ?? 0;
	out.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
	out.usage.totalTokens = out.usage.input + out.usage.output + out.usage.cacheRead + out.usage.cacheWrite;
	out.stopReason = resultEvent?.stop_reason === "max_tokens" ? "length" : "stop";
	stream.push({ type: "done", reason: out.stopReason, message: out });
	stream.end();
}

export default function (pi: ExtensionAPI) {
	logger = pi.logger;
	const rolesSetting = lookup("modelRoles");
	readRoles = () => (rolesSetting?.get(pi.pi.settings) as Record<string, string> | undefined) ?? {};

	// Typed or RPC-sent messages are the user; extension-injected ones are not.
	pi.on("input", (event: any) => {
		if (event.source !== "extension") runsSinceUserInput = 0;
	});
	// Never keep the prompt cache warm through this provider: each refresh is a full run.
	pi.on("cache_warming_decision", (_event: any, ctx: any) =>
		ctx?.model?.provider === PROVIDER ? { action: "stop" } : undefined,
	);

	pi.registerProvider(PROVIDER, {
		baseUrl: "https://cc-cli.invalid/", // required metadata only; never contacted
		apiKey: "unused-by-extension",
		api: API,
		streamSimple(model, context, options) {
			const stream = new AssistantMessageEventStream();
			void run(stream, model, context, options);
			return stream;
		},
		models: MODELS,
	});
}
