import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ConversationId, MailboxId, TenantId } from "../../../shared/types/index.js";
import type { ConversationState } from "./conversation-state.js";

export const CONVERSATION_CHANNELS = ["EMAIL", "LINKEDIN"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export interface Conversation {
  readonly id: ConversationId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly channel: ConversationChannel;
  readonly provider: MailboxProviderType;
  readonly providerThreadId?: string;
  readonly syntheticThreadKey: string;
  readonly state: ConversationState;
  readonly subject?: string;
  readonly firstMessageAt: Date;
  readonly lastMessageAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function computeSyntheticThreadKey(input: {
  readonly provider: MailboxProviderType;
  readonly providerThreadId?: string;
  readonly providerMessageId?: string;
  readonly rfcMessageId?: string;
  readonly dedupeKey?: string;
}): string {
  if (input.providerThreadId) {
    return `${input.provider.toLowerCase()}-thread:${input.providerThreadId}`;
  }
  if (input.providerMessageId) {
    return `unthreaded:${input.provider.toLowerCase()}:${input.providerMessageId}`;
  }
  if (input.rfcMessageId) {
    return `unthreaded-rfc:${input.rfcMessageId}`;
  }
  if (input.dedupeKey) {
    return `unthreaded-dedupe:${input.dedupeKey}`;
  }
  return "unthreaded:unknown";
}
