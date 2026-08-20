import { PermanentError, ProviderError, TransientError } from "../../../shared/errors/index.js";
import type { AiClassificationRequest, AiClassifierProvider } from "../application/ai-classifier-provider.js";

export interface HttpAiClassifierProviderOptions {
  readonly provider: "openai" | "openrouter";
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class HttpAiClassifierProvider implements AiClassifierProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: HttpAiClassifierProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.url = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputChars = options.maxOutputChars;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extraHeaders =
      options.provider === "openrouter" ? { "HTTP-Referer": "https://skout.local", "X-Title": "skout-email-warmup-service" } : {};
  }

  async classifyRaw(request: AiClassificationRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPayload },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      throw new TransientError(isTimeout ? "Timed out waiting for the classification model" : "Could not reach the classification model", {
        cause: error,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new PermanentError(`Classification model authentication failed (HTTP ${response.status})`);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ProviderError("AI", `Classification model failed with HTTP ${response.status}`, { retryable: true });
    }
    if (!response.ok) {
      throw new PermanentError(`Classification model failed with HTTP ${response.status}`);
    }

    const parsed = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new PermanentError("Classification model returned an empty response");
    }
    if (content.length > this.maxOutputChars) {
      throw new PermanentError("Classification model response exceeded the maximum output size");
    }

    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new PermanentError("Classification model returned invalid JSON");
    }
  }
}
