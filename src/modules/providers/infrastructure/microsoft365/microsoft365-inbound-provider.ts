import type { ProviderCredential } from "../../domain/provider-credential.js";
import type { InboundMessageProvider } from "../../../conversations/application/inbound-message-provider.js";
import {
  HistoryCursorInvalidError,
  type ListChangesResult,
  type NormalizedInbound,
} from "../../../conversations/domain/normalized-inbound.js";
import { truncateTextBody } from "../../../conversations/domain/conversation-message.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SELECT =
  "id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,sentDateTime,body,internetMessageHeaders";
const REQUEST_TIMEOUT_MS = 15_000;
const GRAPH_MATCH_WINDOW_MS = 15 * 60 * 1000;

export interface GraphCursor {
  readonly inbox?: string;
  readonly sent?: string;
}

export function parseGraphCursor(cursor: string | undefined): GraphCursor {
  if (!cursor) {
    return {};
  }
  try {
    const parsed = JSON.parse(cursor) as GraphCursor;
    return {
      ...(typeof parsed.inbox === "string" ? { inbox: parsed.inbox } : {}),
      ...(typeof parsed.sent === "string" ? { sent: parsed.sent } : {}),
    };
  } catch {
    return { inbox: cursor };
  }
}

export function serializeGraphCursor(cursor: GraphCursor): string {
  const payload: Record<string, string> = {};
  if (cursor.inbox) payload.inbox = cursor.inbox;
  if (cursor.sent) payload.sent = cursor.sent;
  return JSON.stringify(payload);
}

export interface Microsoft365InboundProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function accessTokenOf(credential: ProviderCredential): string | undefined {
  const token = credential.secretData.accessToken;
  return typeof token === "string" ? token : undefined;
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
}

function headerValue(headers: GraphMessage["internetMessageHeaders"], name: string): string | undefined {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;
}

function normalizeGraphMessage(body: GraphMessage, direction: "INBOUND" | "OUTBOUND"): NormalizedInbound | null {
  if (!body.id) {
    return null;
  }
  const sentAtRaw = direction === "OUTBOUND" ? body.sentDateTime : body.receivedDateTime ?? body.sentDateTime;
  const sentAt = sentAtRaw ? new Date(sentAtRaw) : new Date();
  const textBody = body.body?.contentType?.toLowerCase() === "text" ? truncateTextBody(body.body.content) : undefined;
  const inReplyTo = headerValue(body.internetMessageHeaders, "In-Reply-To");
  const references = headerValue(body.internetMessageHeaders, "References");
  return {
    provider: "MICROSOFT365",
    direction,
    providerMessageId: body.id,
    ...(body.conversationId ? { providerThreadId: body.conversationId } : {}),
    ...(body.internetMessageId ? { rfcMessageId: body.internetMessageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    sender: body.from?.emailAddress?.address ?? "unknown",
    recipients: (body.toRecipients ?? []).map((recipient) => recipient.emailAddress?.address).filter((address): address is string => Boolean(address)),
    ...(body.subject ? { subject: body.subject } : {}),
    ...(textBody ? { textBody } : {}),
    sentAt,
  };
}

export function matchGraphSentItem(
  intent: { subject?: string; recipient?: string; sentAt: Date },
  candidate: NormalizedInbound,
): boolean {
  if (candidate.direction !== "OUTBOUND") {
    return false;
  }
  if (intent.subject !== undefined && candidate.subject !== intent.subject) {
    return false;
  }
  if (intent.recipient && !candidate.recipients.some((recipient) => recipient.toLowerCase() === intent.recipient!.toLowerCase())) {
    return false;
  }
  return Math.abs(candidate.sentAt.getTime() - intent.sentAt.getTime()) <= GRAPH_MATCH_WINDOW_MS;
}

export class Microsoft365InboundProvider implements InboundMessageProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: Microsoft365InboundProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async listChanges(credential: ProviderCredential, cursor: string | undefined): Promise<ListChangesResult> {
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      throw new HistoryCursorInvalidError("MICROSOFT365", "No Microsoft credential is stored for this mailbox.");
    }
    const parsed = parseGraphCursor(cursor);
    if (!cursor) {
      const inbox = await this.deltaFolder(accessToken, "inbox", undefined, "INBOUND", true);
      const sent = await this.deltaFolder(accessToken, "sentitems", undefined, "OUTBOUND", true);
      return {
        messages: [],
        nextCursor: serializeGraphCursor({
          ...(inbox.nextCursor ? { inbox: inbox.nextCursor } : {}),
          ...(sent.nextCursor ? { sent: sent.nextCursor } : {}),
        }),
        bootstrapOnly: true,
      };
    }
    const inbox = await this.deltaFolder(accessToken, "inbox", parsed.inbox, "INBOUND", false);
    const sent = await this.deltaFolder(accessToken, "sentitems", parsed.sent, "OUTBOUND", false);
    return {
      messages: [...inbox.messages, ...sent.messages],
      nextCursor: serializeGraphCursor({
        ...(inbox.nextCursor ? { inbox: inbox.nextCursor } : {}),
        ...(sent.nextCursor ? { sent: sent.nextCursor } : {}),
      }),
      bootstrapOnly: !cursor && inbox.messages.length === 0 && sent.messages.length === 0,
    };
  }

  async listRecentSent(credential: ProviderCredential): Promise<readonly NormalizedInbound[]> {
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      return [];
    }
    const url = `${GRAPH_BASE}/me/mailFolders/sentitems/messages?$top=20&$orderby=sentDateTime desc&$select=${SELECT}`;
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json().catch(() => ({}))) as { value?: GraphMessage[] };
    const messages: NormalizedInbound[] = [];
    for (const item of payload.value ?? []) {
      const normalized = normalizeGraphMessage(item, "OUTBOUND");
      if (normalized) {
        messages.push(normalized);
      }
    }
    return messages;
  }

  async getMessage(credential: ProviderCredential, providerMessageId: string): Promise<NormalizedInbound | null> {
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      return null;
    }
    const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(providerMessageId)}?$select=${SELECT}`;
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => ({}))) as GraphMessage;
    return normalizeGraphMessage(body, "OUTBOUND");
  }

  private async deltaFolder(
    accessToken: string,
    folder: "inbox" | "sentitems",
    cursor: string | undefined,
    direction: "INBOUND" | "OUTBOUND",
    discardMessages: boolean,
  ): Promise<{ messages: NormalizedInbound[]; nextCursor?: string }> {
    const initial = `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$select=${SELECT}`;
    let url: string | undefined = cursor ?? initial;
    const messages: NormalizedInbound[] = [];
    let nextCursor: string | undefined = cursor;

    while (url) {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 410) {
        throw new HistoryCursorInvalidError("MICROSOFT365", "Microsoft Graph delta cursor is no longer valid; explicit resync required.");
      }
      if (!response.ok) {
        throw new HistoryCursorInvalidError("MICROSOFT365", `Microsoft Graph delta failed with HTTP ${response.status}.`);
      }
      const payload = (await response.json().catch(() => ({}))) as {
        value?: GraphMessage[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      for (const item of payload.value ?? []) {
        if (discardMessages) {
          continue;
        }
        const normalized = normalizeGraphMessage(item, direction);
        if (normalized) {
          messages.push(normalized);
        }
      }
      url = payload["@odata.nextLink"];
      nextCursor = payload["@odata.deltaLink"] ?? nextCursor;
    }

    return { messages, ...(nextCursor ? { nextCursor } : {}) };
  }
}
