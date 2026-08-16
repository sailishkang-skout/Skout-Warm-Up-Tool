import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import { PolicyError } from "../../../shared/errors/index.js";
import type { ProviderAccountId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ProviderSendOutcome } from "../domain/send-message.js";
import { resolveFreshCredential } from "./resolve-fresh-credential.js";
import type { ProviderCredentialStore } from "./provider-credential-store.js";
import type { ProviderRegistry } from "./provider-registry.js";

export interface CertifyProviderSendDeps {
  readonly providerRegistry: ProviderRegistry;
  readonly credentialStore: ProviderCredentialStore;
  readonly auditRecorder: AuditEventRecorder;
}

export interface CertifyProviderSendInput {
  readonly tenantId: TenantId;
  readonly providerAccountId: ProviderAccountId;
  readonly provider: MailboxProviderType;
  /** The connected mailbox's own address — never a value this function guesses or defaults. */
  readonly fromAddress: string;
  /**
   * Explicit, operator-supplied recipient (hardening spec Gap B section 3:
   * "No hardcoded recipient addresses"). This function has no default and
   * no fallback — the caller (the `certify-provider-send` CLI) must read
   * it from an environment variable set for this run only.
   */
  readonly recipientEmail: string;
}

export interface CertifyProviderSendResult {
  readonly provider: MailboxProviderType;
  /** The adapter's own normalized outcome — already safe by contract (no tokens, no raw provider bodies; see `domain/send-message.ts`). */
  readonly outcome: ProviderSendOutcome;
}

function buildCertificationMessage(fromAddress: string, recipientEmail: string) {
  const timestamp = new Date().toISOString();
  return {
    from: fromAddress,
    to: recipientEmail,
    subject: `Skout provider certification — ${timestamp}`,
    body:
      "This is a controlled, manually-triggered certification send from the Skout email warmup service, " +
      "used to verify a provider integration end-to-end before enabling it for real warmup traffic. " +
      "It is not a warmup message and was not sent by the automated execution worker. No action is needed.",
  };
}

/**
 * The narrow core of manual provider certification (hardening spec Gap B):
 * proves the real `ProviderAdapter.sendMessage` path — OAuth credential
 * resolution, the actual HTTP call, and the provider's actual response —
 * works end-to-end against a real account, without building a second send
 * implementation. Reuses exactly the same `ProviderRegistry`/
 * `resolveFreshCredential` production code every other send path in this
 * service uses; certifying anything else would prove nothing about what
 * actually runs in production.
 *
 * Deliberately NOT wired into `composition/build-services.ts` — it is not
 * part of `AppServices`, not reachable from any HTTP route, and not
 * imported by `execution-worker.ts` or any other ordinary warmup code
 * path. Its only caller is `src/cli/certify-provider-send.ts`, a
 * standalone script gated behind an explicit opt-in environment variable —
 * see that file for the safety gates. This function does not add any gate
 * of its own beyond "does this provider account currently have a usable
 * credential and does its adapter support sending" — the *decision* to run
 * a live send at all is entirely the CLI's responsibility, not this
 * function's.
 *
 * Never fabricates success: if `adapter.sendMessage` is absent, or no
 * usable credential resolves, this throws/returns the same honest,
 * fail-closed outcomes the production send path does — a certification run
 * against a misconfigured provider proves the misconfiguration, not a
 * false positive.
 */
export async function certifyProviderSend(deps: CertifyProviderSendDeps, input: CertifyProviderSendInput): Promise<CertifyProviderSendResult> {
  const { providerRegistry, credentialStore, auditRecorder } = deps;

  const adapter = providerRegistry.resolve(input.provider);
  if (!adapter.sendMessage) {
    throw new PolicyError(`Provider ${input.provider} has no certified send capability in this deployment — cannot run certification`);
  }

  const credential = await resolveFreshCredential(input.tenantId, input.providerAccountId, adapter, credentialStore, auditRecorder);
  const message = buildCertificationMessage(input.fromAddress, input.recipientEmail);
  const outcome = await adapter.sendMessage(credential, { from: message.from, to: message.to, subject: message.subject, body: message.body });

  return { provider: input.provider, outcome };
}
