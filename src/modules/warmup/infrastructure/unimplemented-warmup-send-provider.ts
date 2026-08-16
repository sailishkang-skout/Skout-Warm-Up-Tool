import type { ProviderSendResult } from "../domain/send-result.js";
import type { SendWarmupMessageCommand, WarmupSendProvider } from "../application/warmup-send-provider.js";

/**
 * The only `WarmupSendProvider` registered in composition for Stage 8 —
 * see `warmup-send-provider.ts`'s doc comment for why no real send exists
 * yet. Every call reports an honest, non-retryable `PERMANENT_FAILURE`
 * rather than fabricating success or silently doing nothing (Stage 8 spec
 * section 34: "no secret leakage," and the whole codebase's standing rule
 * against ever claiming an operation succeeded that didn't happen — same
 * pattern Stage 5 established for an unconfigured provider adapter).
 *
 * This means the execution worker built in this stage is fully exercised
 * end-to-end (claim → lease → safety gate → call the port → record a
 * normalized, terminal result) without ever attempting a real network
 * send — exactly the "keep execution conservative... do not build a
 * high-volume warmup campaign" instruction in Stage 8 spec section 30.
 */
export function createUnimplementedWarmupSendProvider(): WarmupSendProvider {
  return {
    async sendWarmupMessage(command: SendWarmupMessageCommand): Promise<ProviderSendResult> {
      return {
        status: "PERMANENT_FAILURE",
        provider: command.provider,
        timestamp: new Date(),
        retryable: false,
        safeReason: "Provider send capability is not implemented in this deployment yet (Stage 8 is the execution foundation only).",
      };
    },
  };
}
