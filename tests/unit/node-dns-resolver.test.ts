import { describe, expect, it } from "vitest";
import { createNodeDnsResolver } from "../../src/modules/domain-intelligence/infrastructure/node-dns-resolver.js";

function enotfound(): Error {
  const error = new Error("queryTxt ENOTFOUND example.com") as NodeJS.ErrnoException;
  error.code = "ENOTFOUND";
  return error;
}

function servfail(): Error {
  const error = new Error("queryTxt ESERVFAIL example.com") as NodeJS.ErrnoException;
  error.code = "ESERVFAIL";
  return error;
}

describe("createNodeDnsResolver — MX", () => {
  it("PASS: returns records sorted by priority", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [
        { exchange: "mx2.example.com", priority: 20 },
        { exchange: "mx1.example.com", priority: 10 },
      ],
      resolveTxtFn: async () => [],
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.mx).toEqual({ status: "PASS", records: ["mx1.example.com", "mx2.example.com"] });
  });

  it("MISSING: no MX records", async () => {
    const resolver = createNodeDnsResolver({ resolveMxFn: async () => [], resolveTxtFn: async () => [] });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.mx.status).toBe("MISSING");
  });

  it("MISSING: NXDOMAIN maps to MISSING, not ERROR", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => {
        throw enotfound();
      },
      resolveTxtFn: async () => [],
    });
    const result = await resolver.resolveDomainAuthentication("nonexistent-domain.test");
    expect(result.mx.status).toBe("MISSING");
  });

  it("ERROR: a genuine resolver failure maps to ERROR, never the raw error", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => {
        throw servfail();
      },
      resolveTxtFn: async () => [],
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.mx.status).toBe("ERROR");
  });

  it("ERROR: a timeout maps to ERROR, and never hangs the caller", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: () => new Promise(() => {}), // never resolves
      resolveTxtFn: async () => [],
      timeoutMs: 20,
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.mx.status).toBe("ERROR");
  });
});

describe("createNodeDnsResolver — SPF", () => {
  it("PASS: single v=spf1 record", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async (domain) => (domain === "example.com" ? [["v=spf1 include:_spf.example.com -all"]] : []),
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.spf).toEqual({ status: "PASS", record: "v=spf1 include:_spf.example.com -all" });
  });

  it("MISSING: no v=spf1 record among TXT records", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async () => [["some other unrelated txt record"]],
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.spf.status).toBe("MISSING");
  });

  it("FAIL: more than one SPF record is invalid, not silently picked", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async () => [["v=spf1 -all"], ["v=spf1 include:other.com -all"]],
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.spf.status).toBe("FAIL");
  });

  it("reassembles a TXT record split across multiple chunks", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async () => [["v=spf1 ", "include:_spf.example.com ", "-all"]],
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.spf.record).toBe("v=spf1 include:_spf.example.com -all");
  });
});

describe("createNodeDnsResolver — DMARC", () => {
  it("PASS: parses the policy tag", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async (domain) => (domain === "_dmarc.example.com" ? [["v=DMARC1; p=quarantine; rua=mailto:x@example.com"]] : []),
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.dmarc).toMatchObject({ status: "PASS", policy: "quarantine" });
  });

  it("MISSING: no _dmarc TXT record", async () => {
    const resolver = createNodeDnsResolver({ resolveMxFn: async () => [], resolveTxtFn: async () => [] });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.dmarc.status).toBe("MISSING");
  });

  it("FAIL: a record exists but has no valid p= tag (malformed)", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async (domain) => (domain === "_dmarc.example.com" ? [["v=DMARC1; rua=mailto:x@example.com"]] : []),
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.dmarc.status).toBe("FAIL");
  });

  it("does not claim DMARC alone proves deliverability — PASS only reports the record/policy, nothing more", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async (domain) => (domain === "_dmarc.example.com" ? [["v=DMARC1; p=reject"]] : []),
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(Object.keys(result.dmarc).sort()).toEqual(["policy", "record", "status"].sort());
  });
});

describe("createNodeDnsResolver — DKIM", () => {
  it("PASS: finds a record at one of the common selectors", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async (domain) => {
        if (domain === "google._domainkey.example.com") {
          return [["v=DKIM1; k=rsa; p=abc123"]];
        }
        throw enotfound();
      },
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.dkim).toEqual({ status: "PASS", selector: "google" });
  });

  it("MISSING: none of the common selectors resolve", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async () => {
        throw enotfound();
      },
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.dkim.status).toBe("MISSING");
  });

  it("ERROR: a genuine resolver failure on every selector attempt is reported, not silently treated as MISSING", async () => {
    const resolver = createNodeDnsResolver({
      resolveMxFn: async () => [],
      resolveTxtFn: async () => {
        throw servfail();
      },
    });
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.dkim.status).toBe("ERROR");
  });
});

describe("createNodeDnsResolver — overall assessment", () => {
  it("stamps checkedAt and the requested domain", async () => {
    const resolver = createNodeDnsResolver({ resolveMxFn: async () => [], resolveTxtFn: async () => [] });
    const before = Date.now();
    const result = await resolver.resolveDomainAuthentication("example.com");
    expect(result.domain).toBe("example.com");
    expect(result.checkedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
