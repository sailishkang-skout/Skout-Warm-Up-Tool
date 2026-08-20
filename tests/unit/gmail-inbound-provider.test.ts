import { describe, expect, it, vi } from "vitest";
import { GmailInboundProvider } from "../../src/modules/providers/infrastructure/gmail/gmail-inbound-provider.js";
import { HistoryCursorInvalidError } from "../../src/modules/conversations/domain/normalized-inbound.js";
import { asProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";

function credential(): ProviderCredential {
  return {
    providerAccountId: asProviderAccountId("11111111-1111-1111-1111-111111111111"),
    kind: "GOOGLE_OAUTH",
    secretData: { accessToken: "token" },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("GmailInboundProvider", () => {
  it("bootstraps from the current historyId without fetching messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ historyId: "99" }));
    const provider = new GmailInboundProvider({ fetchImpl });
    const result = await provider.listChanges(credential(), undefined);
    expect(result.bootstrapOnly).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBe("99");
  });

  it("marks an invalid history cursor instead of skipping it", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "notFound" }, 404));
    const provider = new GmailInboundProvider({ fetchImpl });
    await expect(provider.listChanges(credential(), "stale")).rejects.toBeInstanceOf(HistoryCursorInvalidError);
  });

  it("normalizes Gmail thread and RFC headers from messages.get", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
          historyId: "101",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "m1",
          threadId: "th1",
          labelIds: ["INBOX"],
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "From", value: "Ada <ada@example.com>" },
              { name: "To", value: "me@skout.test" },
              { name: "Subject", value: "Hello" },
              { name: "Message-ID", value: "<rfc-1@example.com>" },
              { name: "In-Reply-To", value: "<rfc-0@example.com>" },
              { name: "References", value: "<rfc-0@example.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("plain text").toString("base64url") },
          },
        }),
      );
    const provider = new GmailInboundProvider({ fetchImpl });
    const result = await provider.listChanges(credential(), "100");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "m1",
      providerThreadId: "th1",
      rfcMessageId: "<rfc-1@example.com>",
      inReplyTo: "<rfc-0@example.com>",
      sender: "ada@example.com",
      textBody: "plain text",
    });
  });

  it("treats malformed JSON as an empty payload rather than throwing raw parse errors on history", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = new GmailInboundProvider({ fetchImpl });
    const result = await provider.listChanges(credential(), "100");
    expect(result.messages).toEqual([]);
  });
});
