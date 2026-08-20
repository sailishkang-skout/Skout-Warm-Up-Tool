import { describe, expect, it } from "vitest";
import {
  applyRecentInteractionAvoidance,
  compareWarmupMailboxCandidates,
  selectRankedWarmupMailbox,
} from "../../src/modules/warmup-network/application/warmup-network-ranking.js";
import { asWarmupNetworkMailboxId } from "../../src/shared/types/index.js";

const a = {
  id: asWarmupNetworkMailboxId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
  provider: "GMAIL" as const,
  healthScore: 70,
  remainingCapacity: 10,
};
const b = {
  id: asWarmupNetworkMailboxId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
  provider: "GMAIL" as const,
  healthScore: 90,
  remainingCapacity: 5,
};
const c = {
  id: asWarmupNetworkMailboxId("cccccccc-cccc-cccc-cccc-cccccccccccc"),
  provider: "MICROSOFT365" as const,
  healthScore: 99,
  remainingCapacity: 50,
};

describe("warmup network ranking", () => {
  it("is deterministic: same provider first, then health, remaining capacity, id", () => {
    const selected = selectRankedWarmupMailbox([a, b, c], "GMAIL");
    expect(selected?.id).toBe(b.id);
  });

  it("prefers a same-provider mailbox over a healthier other-provider mailbox", () => {
    expect(compareWarmupMailboxCandidates(a, c, "GMAIL")).toBeLessThan(0);
  });

  it("falls back to a single remaining mailbox", () => {
    expect(selectRankedWarmupMailbox([a], "MICROSOFT365")?.id).toBe(a.id);
  });

  it("returns undefined when no eligible mailboxes remain", () => {
    expect(selectRankedWarmupMailbox([], "GMAIL")).toBeUndefined();
  });

  it("avoids recent interaction targets, then falls back if that would empty the pool", () => {
    const avoided = applyRecentInteractionAvoidance([a, b], new Set([a.id, b.id]));
    expect(avoided.map((item) => item.id)).toEqual([a.id, b.id]);
    const rotated = applyRecentInteractionAvoidance([a, b], new Set([b.id]));
    expect(rotated.map((item) => item.id)).toEqual([a.id]);
  });

  it("breaks ties by id ascending", () => {
    const twin = { ...b, id: asWarmupNetworkMailboxId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab"), healthScore: 90, remainingCapacity: 5 };
    expect(selectRankedWarmupMailbox([twin, b], "GMAIL")?.id).toBe(twin.id);
  });
});
