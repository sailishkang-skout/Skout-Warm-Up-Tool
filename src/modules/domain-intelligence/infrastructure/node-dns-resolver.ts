import { promises as dns } from "node:dns";
import type {
  DkimCheckResult,
  DmarcCheckResult,
  DmarcPolicy,
  DnsCheckStatus,
  DomainAuthenticationAssessment,
  MxCheckResult,
  SpfCheckResult,
} from "../domain/domain-authentication.js";
import type { DnsResolver } from "../application/dns-resolver.js";

// Bounded and generous enough for a normal resolver round trip, short
// enough that one slow/unresponsive nameserver can never make a mailbox
// request hang — Stage 7 spec section 26: "implement reasonable timeouts."
const DNS_TIMEOUT_MS = 5000;

/**
 * DKIM has no fixed DNS location (see domain/domain-authentication.ts) — a
 * small, fixed list of the selectors real providers actually use in
 * practice. Checking these six is a bounded, well-known lookup, not the
 * "aggressive DNS scanning" Stage 7 spec section 6 warns against; an
 * unrecognized selector simply means DKIM comes back `MISSING`, which is
 * honest (this check cannot prove a negative for a selector it doesn't
 * know to try).
 */
const COMMON_DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "k1", "dkim"] as const;

type ResolveMxFn = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
type ResolveTxtFn = (domain: string) => Promise<string[][]>;

export interface NodeDnsResolverOptions {
  readonly resolveMxFn?: ResolveMxFn;
  readonly resolveTxtFn?: ResolveTxtFn;
  readonly timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS query timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `ENOTFOUND`/`ENODATA` mean "the resolver definitively has no such record"
 * — a real, safe-to-report `MISSING`, not a failure. Everything else
 * (timeout, `ESERVFAIL`, `ECONNREFUSED`, ...) is a genuine query failure
 * and becomes `ERROR` — never surfaced as the raw Node error (Stage 7 spec
 * section 26: "no raw DNS infrastructure errors exposed").
 */
function classifyDnsError(error: unknown): DnsCheckStatus {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTFOUND" || code === "ENODATA" ? "MISSING" : "ERROR";
}

function joinTxtRecords(records: string[][]): string[] {
  return records.map((chunks) => chunks.join(""));
}

function parseDmarcPolicy(record: string): DmarcPolicy | undefined {
  const match = /(?:^|;)\s*p=(none|quarantine|reject)\s*(?:;|$)/i.exec(record);
  const policy = match?.[1]?.toLowerCase();
  return policy === "none" || policy === "quarantine" || policy === "reject" ? policy : undefined;
}

async function checkMx(domain: string, resolveMxFn: ResolveMxFn, timeoutMs: number): Promise<MxCheckResult> {
  try {
    const records = await withTimeout(resolveMxFn(domain), timeoutMs);
    if (records.length === 0) {
      return { status: "MISSING", records: [] };
    }
    const sorted = [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    return { status: "PASS", records: sorted };
  } catch (error) {
    return { status: classifyDnsError(error), records: [] };
  }
}

async function checkSpf(domain: string, resolveTxtFn: ResolveTxtFn, timeoutMs: number): Promise<SpfCheckResult> {
  try {
    const records = joinTxtRecords(await withTimeout(resolveTxtFn(domain), timeoutMs));
    const spfRecords = records.filter((r) => /^v=spf1(\s|$)/i.test(r));
    if (spfRecords.length === 0) {
      return { status: "MISSING" };
    }
    // More than one SPF record is explicitly invalid per RFC 7208 — an
    // unambiguous FAIL, not "pick one and pretend it's fine."
    if (spfRecords.length > 1) {
      return { status: "FAIL", record: spfRecords[0]! };
    }
    return { status: "PASS", record: spfRecords[0]! };
  } catch (error) {
    return { status: classifyDnsError(error) };
  }
}

async function checkDmarc(domain: string, resolveTxtFn: ResolveTxtFn, timeoutMs: number): Promise<DmarcCheckResult> {
  try {
    const records = joinTxtRecords(await withTimeout(resolveTxtFn(`_dmarc.${domain}`), timeoutMs));
    const dmarcRecords = records.filter((r) => /^v=dmarc1(\s|;)/i.test(r));
    if (dmarcRecords.length === 0) {
      return { status: "MISSING" };
    }
    if (dmarcRecords.length > 1) {
      return { status: "FAIL", record: dmarcRecords[0]! };
    }
    const record = dmarcRecords[0]!;
    const policy = parseDmarcPolicy(record);
    if (!policy) {
      // A record exists but has no valid `p=` tag — malformed, not absent.
      return { status: "FAIL", record };
    }
    return { status: "PASS", policy, record };
  } catch (error) {
    return { status: classifyDnsError(error) };
  }
}

async function checkDkim(domain: string, resolveTxtFn: ResolveTxtFn, timeoutMs: number): Promise<DkimCheckResult> {
  let sawError = false;
  for (const selector of COMMON_DKIM_SELECTORS) {
    try {
      const records = joinTxtRecords(await withTimeout(resolveTxtFn(`${selector}._domainkey.${domain}`), timeoutMs));
      const dkimRecord = records.find((r) => /(?:^|;)\s*(v=dkim1|k=|p=)/i.test(r));
      if (dkimRecord) {
        return { status: "PASS", selector };
      }
    } catch (error) {
      if (classifyDnsError(error) === "ERROR") {
        sawError = true;
      }
      // MISSING for this selector just means "try the next one."
    }
  }
  return { status: sawError ? "ERROR" : "MISSING" };
}

/**
 * Real DNS-backed `DnsResolver`. `resolveMxFn`/`resolveTxtFn` default to
 * `node:dns/promises` but are injectable so tests exercise this module's
 * classification/parsing logic without real network access (Stage 7 spec
 * section 27: MX/SPF/DMARC pass/fail, missing records, timeout/error,
 * malformed records — all reachable by injecting a fake resolver).
 */
export function createNodeDnsResolver(options: NodeDnsResolverOptions = {}): DnsResolver {
  const resolveMxFn = options.resolveMxFn ?? dns.resolveMx.bind(dns);
  const resolveTxtFn = options.resolveTxtFn ?? dns.resolveTxt.bind(dns);
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;

  return {
    async resolveDomainAuthentication(domain: string): Promise<DomainAuthenticationAssessment> {
      const [mx, spf, dkim, dmarc] = await Promise.all([
        checkMx(domain, resolveMxFn, timeoutMs),
        checkSpf(domain, resolveTxtFn, timeoutMs),
        checkDkim(domain, resolveTxtFn, timeoutMs),
        checkDmarc(domain, resolveTxtFn, timeoutMs),
      ]);

      return { domain, mx, spf, dkim, dmarc, checkedAt: new Date() };
    },
  };
}
