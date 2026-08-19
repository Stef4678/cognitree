import { Notice } from 'obsidian';
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

/**
 * Minimal OpenAI-compatible chat-completions client (works with DeepSeek,
 * OpenAI, OpenRouter, Ollama, LM Studio, …). Supports SSE streaming.
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
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${apiKey}` },
			});
			if (!res.ok) return [];
			const data = (await res.json()) as { data?: { id?: string }[] };
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
	 * Streams when settings.streaming is true and onDelta is provided.
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

		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 180_000);
		if (opts.signal) {
			opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
		}

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!res.ok) {
				let detail = '';
				try {
					detail = (await res.text()).slice(0, 500);
				} catch {
					/* ignore */
				}
				throw new ApiError(
					`API request failed (${res.status}): ${detail || res.statusText}`,
					res.status
				);
			}

			if (body.stream) {
				return await this.readStream(res, opts.onDelta!);
			}
			const data = (await res.json()) as {
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
		} finally {
			window.clearTimeout(timeout);
		}
	}

	/** Parse an SSE stream of `data:` lines and accumulate assistant deltas. */
	private async readStream(res: Response, onDelta: (d: string) => void): Promise<string> {
		if (!res.body) throw new ApiError('Streaming response has no body.');
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let raw = '';
		let full = '';
		let finishReason = '';
		let sawDataLine = false;
		let sawReasoning = false;

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
				json = JSON.parse(payload);
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
			const text = delta.content ?? (full === '' ? choice.message?.content : undefined);
			if (typeof text === 'string' && text.length > 0) {
				full += text;
				onDelta(text);
			}
			if (choice.finish_reason) finishReason = String(choice.finish_reason);
		};

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			buffer += chunk;
			raw += chunk;
			// SSE lines may end with \n, \r, or \r\n — split on both.
			let nl: number;
			while ((nl = buffer.search(/[\r\n]/)) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				handleLine(line);
			}
		}
		const tail = decoder.decode();
		buffer += tail;
		raw += tail;
		if (buffer.trim()) handleLine(buffer.trim());

		if (finishReason === 'content_filter') {
			throw new ApiError(
				'The provider filtered this response (finish_reason: content_filter). Try rephrasing the request or lowering the temperature.'
			);
		}
		if (!full) {
			// A server may ignore `stream: true` and return a plain JSON body.
			if (!sawDataLine) {
				try {
					const json = JSON.parse(raw) as {
						choices?: { message?: { content?: unknown } }[];
					};
					const text = json.choices?.[0]?.message?.content;
					if (typeof text === 'string' && text.length > 0) return text;
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
