import {
	Notice,
	requestUrl,
	type RequestUrlParam,
	type RequestUrlResponse,
} from 'obsidian';
import { providerFor, type PluginSettings } from './types';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	maxTokens: number;
	temperature: number;
	streaming: boolean;
	/** Called for each streamed text delta (when streaming is enabled). */
	onDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

export class ApiError extends Error {
	status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

/** The model emitted only `reasoning_content` and no final content (token-cut). */
export class ReasoningTruncatedError extends ApiError {
	constructor(message: string) {
		super(message);
		this.name = 'ReasoningTruncatedError';
	}
}

/**
 * Upper bound for the automatic retry budget used when a reasoning model
 * spends its whole token allowance before emitting any answer.
 */
const REASONING_RETRY_MAX_TOKENS = 8000;

/** Longest a single request may take before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Minimal OpenAI-compatible chat-completions client (works with DeepSeek,
 * OpenAI, OpenRouter, Ollama, LM Studio, …). All traffic goes through
 * Obsidian's `requestUrl` (the sanctioned network API) — no `fetch`.
 */
export class ApiClient {
	private readonly settings: PluginSettings;

	constructor(settings: PluginSettings) {
		this.settings = settings;
	}

	/** Normalize the configured endpoint into a full /chat/completions URL. */
	private endpoint(): string {
		let base = (this.settings.modelEndpoint || '').trim().replace(/\/+$/, '');
		if (!base) base = 'https://api.deepseek.com';
		if (base.endsWith('/chat/completions')) return base;
		if (base.endsWith('/v1')) return `${base}/chat/completions`;
		return `${base}/chat/completions`;
	}

	/**
	 * Fetch the model list from the endpoint (`GET /models`, OpenAI-compatible).
	 * Returns [] when the endpoint doesn't support listing or auth fails.
	 */
	async listModels(): Promise<string[]> {
		const apiKey = this.settings.apiKey.trim();
		const provider = providerFor(this.settings.modelEndpoint);
		const needsKey = provider?.keyRequired !== false;
		if (!apiKey && needsKey) return [];
		let base = (this.settings.modelEndpoint || '').trim().replace(/\/+$/, '');
		if (!base) base = 'https://api.deepseek.com';
		if (base.endsWith('/chat/completions')) base = base.replace(/\/chat\/completions$/, '');
		const url = base.endsWith('/models') ? base : `${base}/models`;
		try {
			const res = await requestUrl({
				url,
				method: 'GET',
				headers: { Authorization: `Bearer ${apiKey}` },
				throw: false,
			});
			if (res.status !== 200) return [];
			const data = res.json as { data?: { id?: string }[] };
			const ids = (data?.data ?? [])
				.map((m) => (m?.id ? String(m.id) : ''))
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b));
			return ids;
		} catch {
			return [];
		}
	}

	/**
	 * Run a chat completion and return the full assistant text.
	 * `requestUrl` cannot be aborted or streamed incrementally, so a watchdog
	 * timeout guards against hung servers, and buffered SSE deltas are
	 * replayed through `onDelta` in order (identical content, delivered in
	 * small steps so the UI still paints progressively).
	 */
	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		const apiKey = this.settings.apiKey.trim();
		const provider = providerFor(this.settings.modelEndpoint);
		const needsKey = provider?.keyRequired !== false;
		if (!apiKey && needsKey) {
			throw new ApiError(
				'No API key configured. Open CogniTree settings (gear icon in the view, or Settings → CogniTree) and paste your key.'
			);
		}
		if (opts.signal?.aborted) {
			throw new ApiError('Request was aborted.');
		}

		const url = this.endpoint();
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
		const body = {
			model: this.settings.model || 'deepseek-v4-flash',
			messages,
			max_tokens: opts.maxTokens,
			temperature: opts.temperature,
			stream: opts.streaming && !!opts.onDelta,
		};

		try {
			const res = await this.requestWithTimeout({
				url,
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				throw: false,
			});

			if (res.status >= 400) {
				let detail = '';
				try {
					detail = res.text.slice(0, 500);
				} catch {
					/* ignore */
				}
				throw new ApiError(
					`API request failed (${res.status}): ${detail || `HTTP ${res.status}`}`,
					res.status
				);
			}

			if (opts.signal?.aborted) {
				throw new ApiError('Request was aborted.');
			}

			if (body.stream) {
				return await this.parseSse(res.text, opts.onDelta!);
			}
			const data = res.json as {
				choices?: {
					message?: { content?: string; reasoning_content?: string };
				}[];
			};
			const choice = data?.choices?.[0];
			const text = choice?.message?.content ?? '';
			if (!text) {
				if (choice?.message?.reasoning_content) {
					throw new ReasoningTruncatedError(
						'The model produced only reasoning and no final content — it hit the token limit while reasoning.'
					);
				}
				throw new ApiError('API returned an empty response.');
			}
			return text;
		} catch (err) {
			// Reasoning models (e.g. deepseek-r1, sonar-reasoning) can spend the
			// whole token budget on `reasoning_content` before emitting an
			// answer. Retry once with a larger budget so the model can finish.
			if (
				err instanceof ReasoningTruncatedError &&
				opts.maxTokens < REASONING_RETRY_MAX_TOKENS
			) {
				return await this.chat(messages, {
					...opts,
					maxTokens: Math.min(REASONING_RETRY_MAX_TOKENS, opts.maxTokens * 4),
				});
			}
			if (err instanceof ApiError) throw err;
			if (err instanceof DOMException && err.name === 'AbortError') {
				throw new ApiError('Request timed out or was aborted.');
			}
			throw new ApiError(`Network error: ${(err as Error).message}`);
		}
	}

	/** Run `requestUrl` under a watchdog timeout (requestUrl itself cannot be aborted). */
	private async requestWithTimeout(params: RequestUrlParam): Promise<RequestUrlResponse> {
		let timer = 0;
		try {
			return await Promise.race([
				requestUrl(params),
				new Promise<never>((_, reject) => {
					timer = window.setTimeout(
						() => reject(new ApiError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`)),
						REQUEST_TIMEOUT_MS
					);
				}),
			]);
		} finally {
			window.clearTimeout(timer);
		}
	}

	/**
	 * Parse a buffered SSE body (`data:` lines) and replay the deltas through
	 * `onDelta` with a tiny yield between chunks so the UI can paint them
	 * progressively. Falls back to a plain JSON body when the server ignored
	 * `stream: true`.
	 */
	private async parseSse(text: string, onDelta: (d: string) => void): Promise<string> {
		let full = '';
		let finishReason = '';
		let sawDataLine = false;
		let sawReasoning = false;
		const deltas: string[] = [];

		const handleLine = (line: string) => {
			if (!line.startsWith('data:')) return;
			sawDataLine = true;
			const payload = line.slice(5).trim();
			if (!payload || payload === '[DONE]') return;
			let json: {
				error?: { message?: unknown; type?: unknown; code?: unknown };
				choices?: {
					delta?: { content?: unknown; reasoning_content?: unknown };
					message?: { content?: unknown };
					finish_reason?: unknown;
				}[];
			};
			try {
				json = JSON.parse(payload) as typeof json;
			} catch {
				return; // malformed keepalive — ignore
			}
			// Providers often report failures as an `error` object inside a
			// 200 stream; surface it instead of the generic "no content" message.
			const err = json.error;
			if (err && (err.message || err.type || err.code)) {
				throw new ApiError(`API error: ${String(err.message ?? err.type ?? err.code)}`);
			}
			const choice = json.choices?.[0];
			if (!choice) return;
			const delta = choice.delta ?? {};
			if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
				sawReasoning = true;
			}
			// Standard OpenAI-style streaming uses `delta.content`. Some
			// OpenAI-compatible servers instead deliver the whole answer in a
			// single `message.content` chunk — accept that as a fallback.
			const chunk = delta.content ?? (full === '' ? choice.message?.content : undefined);
			if (typeof chunk === 'string' && chunk.length > 0) {
				full += chunk;
				deltas.push(chunk);
			}
			if (choice.finish_reason) finishReason = String(choice.finish_reason);
		};

		for (const line of text.split(/\r?\n/)) {
			handleLine(line);
		}

		if (finishReason === 'content_filter') {
			throw new ApiError(
				'The provider filtered this response (finish_reason: content_filter). Try rephrasing the request or lowering the temperature.'
			);
		}
		if (!full) {
			// A server may ignore `stream: true` and return a plain JSON body.
			if (!sawDataLine) {
				try {
					const json = JSON.parse(text) as {
						choices?: { message?: { content?: unknown } }[];
					};
					const t = json.choices?.[0]?.message?.content;
					if (typeof t === 'string' && t.length > 0) return t;
				} catch {
					/* not a JSON body — fall through */
				}
			}
			if (sawReasoning) {
				throw new ReasoningTruncatedError(
					'The model produced only reasoning and no final content — it hit the token limit while reasoning.'
				);
			}
			throw new ApiError('Stream finished without any content.');
		}

		// Replay deltas so the caller observes progressive text; yield between
		// chunks so the browser can paint the status updates.
		for (const d of deltas) {
			onDelta(d);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		return full;
	}

	static notice(err: unknown): void {
		if (err instanceof ApiError) {
			new Notice(err.message, 8000);
		} else {
			new Notice(`CogniTree error: ${(err as Error).message}`, 8000);
		}
	}
}
