import type { ProviderCredential } from "../../domain/provider-credential.js";
import type { InboundMessageProvider } from "../../../conversations/application/inbound-message-provider.js";
import {
  HistoryCursorInvalidError,
  type ListChangesResult,
  type NormalizedInbound,
} from "../../../conversations/domain/normalized-inbound.js";
import { truncateTextBody } from "../../../conversations/domain/conversation-message.js";

const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history";
const MESSAGE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GmailInboundProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function accessTokenOf(credential: ProviderCredential): string | undefined {
  const token = credential.secretData.accessToken;
  return typeof token === "string" ? token : undefined;
}

function headerMap(headers: ReadonlyArray<{ name?: string; value?: string }> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    if (header.name && header.value && !map.has(header.name.toLowerCase())) {
      map.set(header.name.toLowerCase(), header.value);
    }
  }
  return map;
}

function decodeBody(data: string | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const padded = data.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (data.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function extractTextPlain(part: GmailPart | undefined): string | undefined {
  if (!part) {
    return undefined;
  }
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBody(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = extractTextPlain(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function parseEmailAddress(raw: string | undefined): string {
  if (!raw) {
    return "unknown";
  }
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim();
}

function parseAddressList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => parseEmailAddress(part))
    .filter(Boolean);
}

function normalizeGmailMessage(body: {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name?: string; value?: string }>; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
  internalDate?: string;
}): NormalizedInbound | null {
  if (!body.id) {
    return null;
  }
  const headers = headerMap(body.payload?.headers);
  const sentAtMs = body.internalDate ? Number(body.internalDate) : Date.now();
  const sentAt = Number.isFinite(sentAtMs) ? new Date(sentAtMs) : new Date();
  const direction = body.labelIds?.includes("SENT") ? "OUTBOUND" : "INBOUND";
  const textBody = truncateTextBody(extractTextPlain(body.payload));
  const rfcMessageId = headers.get("message-id");
  const inReplyTo = headers.get("in-reply-to");
  const references = headers.get("references");
  const subject = headers.get("subject");
  return {
    provider: "GMAIL",
    direction,
    providerMessageId: body.id,
    ...(body.threadId ? { providerThreadId: body.threadId } : {}),
    ...(rfcMessageId ? { rfcMessageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    sender: parseEmailAddress(headers.get("from")),
    recipients: parseAddressList(headers.get("to")),
    ...(subject ? { subject } : {}),
    ...(textBody ? { textBody } : {}),
    sentAt,
  };
}

export class GmailInboundProvider implements InboundMessageProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GmailInboundProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async listChanges(credential: ProviderCredential, cursor: string | undefined): Promise<ListChangesResult> {
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      throw new HistoryCursorInvalidError("GMAIL", "No Google credential is stored for this mailbox.");
    }

    if (!cursor) {
      const profile = await this.getJson<{ historyId?: string }>(accessToken, PROFILE_URL);
      return { messages: [], ...(profile.historyId ? { nextCursor: profile.historyId } : {}), bootstrapOnly: true };
    }

    const url = new URL(HISTORY_URL);
    url.searchParams.set("startHistoryId", cursor);
    url.searchParams.set("historyTypes", "messageAdded");
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 404) {
      throw new HistoryCursorInvalidError("GMAIL", "Gmail history cursor is no longer valid; explicit resync required.");
    }
    if (!response.ok) {
      throw new HistoryCursorInvalidError("GMAIL", `Gmail history.list failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
      historyId?: string;
    };

    const ids = new Set<string>();
    for (const entry of payload.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) {
          ids.add(added.message.id);
        }
      }
    }

    const messages: NormalizedInbound[] = [];
    for (const id of ids) {
      const message = await this.getMessage(credential, id);
      if (message) {
        messages.push(message);
      }
    }

    return { messages, nextCursor: payload.historyId ?? cursor };
  }

  async getMessage(credential: ProviderCredential, providerMessageId: string): Promise<NormalizedInbound | null> {
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      return null;
    }
    const url = `${MESSAGE_URL}/${encodeURIComponent(providerMessageId)}?format=full`;
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => ({}))) as Parameters<typeof normalizeGmailMessage>[0];
    return normalizeGmailMessage(body);
  }

  private async getJson<T>(accessToken: string, url: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new HistoryCursorInvalidError("GMAIL", `Gmail request failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }
}
