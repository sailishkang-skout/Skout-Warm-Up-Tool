import { createHash } from "node:crypto";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ConversationId, MailboxId, MessageId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";

export const MESSAGE_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const TEXT_BODY_MAX_BYTES = 64 * 1024;

export interface ConversationMessage {
  readonly id: MessageId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly conversationId: ConversationId;
  readonly provider: MailboxProviderType;
  readonly direction: MessageDirection;
  readonly providerMessageId?: string;
  readonly rfcMessageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject?: string;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly sentAt: Date;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
  readonly createdAt: Date;
}

export function truncateTextBody(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= TEXT_BODY_MAX_BYTES) {
    return text;
  }
  return buffer.subarray(0, TEXT_BODY_MAX_BYTES).toString("utf8");
}

export interface MessageDedupeKeyInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly direction: MessageDirection;
  readonly sentAt: Date;
  readonly sender: string;
  readonly subject?: string;
  readonly providerMessageId?: string;
  readonly rfcMessageId?: string;
}

/**
 * Only used when the provider and RFC ids are both absent — those cases
 * already have partial unique indexes. Same limitation as delivery-event
 * fallback keys: two independent events sharing every field at the same
 * instant would collide.
 */
export function computeMessageDedupeKey(input: MessageDedupeKeyInput): string | undefined {
  if (input.providerMessageId || input.rfcMessageId) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(`${input.sender}\u0000${input.subject ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `fallback:${input.tenantId}:${input.mailboxId}:${input.provider}:${input.direction}:${input.sentAt.toISOString()}:${digest}`;
}
