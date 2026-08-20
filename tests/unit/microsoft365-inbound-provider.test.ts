import { describe, expect, it, vi } from "vitest";
import {
  matchGraphSentItem,
  Microsoft365InboundProvider,
  parseGraphCursor,
} from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-inbound-provider.js";
import { HistoryCursorInvalidError } from "../../src/modules/conversations/domain/normalized-inbound.js";
import { asProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";
import type { NormalizedInbound } from "../../src/modules/conversations/domain/normalized-inbound.js";

function credential(): ProviderCredential {
  return {
    providerAccountId: asProviderAccountId("11111111-1111-1111-1111-111111111111"),
    kind: "MICROSOFT_OAUTH",
    secretData: { accessToken: "token" },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Microsoft365InboundProvider", () => {
  it("bootstraps delta links without persisting historical mail", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "old-inbox" }], "@odata.deltaLink": "https://graph/inbox-delta" }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "old-sent" }], "@odata.deltaLink": "https://graph/sent-delta" }));
    const provider = new Microsoft365InboundProvider({ fetchImpl });
    const result = await provider.listChanges(credential(), undefined);
    expect(result.bootstrapOnly).toBe(true);
    expect(result.messages).toEqual([]);
    const cursor = parseGraphCursor(result.nextCursor);
    expect(cursor.inbox).toBe("https://graph/inbox-delta");
    expect(cursor.sent).toBe("https://graph/sent-delta");
  });

  it("normalizes Graph conversationId and leaves messages without conversationId unthreaded at persist time", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: "in1",
              internetMessageId: "<g1@contoso>",
              subject: "Hi",
              from: { emailAddress: { address: "a@contoso.com" } },
              toRecipients: [{ emailAddress: { address: "me@skout.test" } }],
              receivedDateTime: "2026-01-01T00:00:00Z",
              body: { contentType: "text", content: "hello" },
            },
          ],
          "@odata.deltaLink": "https://graph/inbox-delta-2",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "https://graph/sent-delta-2" }));
    const provider = new Microsoft365InboundProvider({ fetchImpl });
    const result = await provider.listChanges(credential(), JSON.stringify({ inbox: "https://graph/inbox", sent: "https://graph/sent" }));
    expect(result.messages[0]?.providerThreadId).toBeUndefined();
    expect(result.messages[0]?.providerMessageId).toBe("in1");
  });

  it("treats HTTP 410 as an invalid delta cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, 410));
    const provider = new Microsoft365InboundProvider({ fetchImpl });
    await expect(
      provider.listChanges(credential(), JSON.stringify({ inbox: "https://stale", sent: "https://stale" })),
    ).rejects.toBeInstanceOf(HistoryCursorInvalidError);
  });

  it("does not invent a provider message id — getMessage returns null on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, 404));
    const provider = new Microsoft365InboundProvider({ fetchImpl });
    await expect(provider.getMessage(credential(), "missing")).resolves.toBeNull();
  });

  it("matches Graph sent items only inside a conservative window", () => {
    const sentAt = new Date("2026-01-01T12:00:00.000Z");
    const candidate: NormalizedInbound = {
      provider: "MICROSOFT365",
      direction: "OUTBOUND",
      sender: "me@skout.test",
      recipients: ["me@skout.test"],
      sentAt,
      subject: "Warmup",
    };
    expect(matchGraphSentItem({ recipient: "me@skout.test", sentAt }, candidate)).toBe(true);
    expect(
      matchGraphSentItem({ recipient: "me@skout.test", sentAt: new Date("2026-01-01T13:00:00.000Z") }, candidate),
    ).toBe(false);
  });
});
