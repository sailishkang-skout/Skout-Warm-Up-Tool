import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { MessageDirection } from "./conversation-message.js";

/**
 * Provider-agnostic snapshot of one email after inbound fetch or outbound
 * materialization. Must never include raw provider JSON, tokens, or HTML.
 */
export interface NormalizedInbound {
  readonly provider: MailboxProviderType;
  readonly direction: MessageDirection;
  readonly providerMessageId?: string;
  readonly providerThreadId?: string;
  readonly rfcMessageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject?: string;
  readonly textBody?: string;
  readonly sentAt: Date;
}

export interface ListChangesResult {
  readonly messages: readonly NormalizedInbound[];
  readonly nextCursor?: string;
  /** True when we only captured a starting historyId and fetched no mail. */
  readonly bootstrapOnly?: boolean;
}

export class HistoryCursorInvalidError extends Error {
  readonly provider: MailboxProviderType;

  constructor(provider: MailboxProviderType, message: string) {
    super(message);
    this.name = "HistoryCursorInvalidError";
    this.provider = provider;
  }
}
