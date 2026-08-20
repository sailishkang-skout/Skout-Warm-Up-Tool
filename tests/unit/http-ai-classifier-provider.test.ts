import { describe, expect, it } from "vitest";
import { HttpAiClassifierProvider } from "../../src/modules/conversations/infrastructure/http-ai-classifier-provider.js";
import { PermanentError, ProviderError, TransientError } from "../../src/shared/errors/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function provider(fetchImpl: typeof fetch, timeoutMs = 15_000) {
  return new HttpAiClassifierProvider({
    provider: "openrouter",
    apiKey: "test-key",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini",
    timeoutMs,
    maxOutputChars: 200,
    fetchImpl,
  });
}

const request = { systemPrompt: "sys", userPayload: "user" };

describe("HttpAiClassifierProvider", () => {
  it("parses a valid JSON object from the model", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ labels: ["NEUTRAL"], primaryLabel: "NEUTRAL", confidence: 0.4, reason: "ok" }) } }],
      });
    await expect(provider(fetchImpl).classifyRaw(request)).resolves.toEqual({
      labels: ["NEUTRAL"],
      primaryLabel: "NEUTRAL",
      confidence: 0.4,
      reason: "ok",
    });
  });

  it("rejects invalid JSON", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, { choices: [{ message: { content: "not-json" } }] });
    await expect(provider(fetchImpl).classifyRaw(request)).rejects.toBeInstanceOf(PermanentError);
  });

  it("treats 429 as retryable", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(429, {});
    await expect(provider(fetchImpl).classifyRaw(request)).rejects.toMatchObject({ retryable: true });
  });

  it("treats 5xx as retryable", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(503, {});
    await expect(provider(fetchImpl).classifyRaw(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("treats authentication failure as permanent", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(401, {});
    await expect(provider(fetchImpl).classifyRaw(request)).rejects.toBeInstanceOf(PermanentError);
  });

  it("rejects oversized model output", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, { choices: [{ message: { content: "x".repeat(201) } }] });
    await expect(provider(fetchImpl).classifyRaw(request)).rejects.toBeInstanceOf(PermanentError);
  });

  it("maps timeouts to a transient error", async () => {
    const fetchImpl: typeof fetch = async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    };
    await expect(provider(fetchImpl, 10).classifyRaw(request)).rejects.toBeInstanceOf(TransientError);
  });
});
