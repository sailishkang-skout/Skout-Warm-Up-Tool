/**
 * Deliberately five states, not a boolean — Stage 7 spec section 7: "Do not
 * simplify all failures into one boolean." `MISSING` (the record genuinely
 * doesn't exist, e.g. NXDOMAIN) is a different fact than `ERROR` (the query
 * itself failed — timeout, resolver error), which is different again from
 * `FAIL` (a record exists but is malformed or explicitly disallows the
 * check). `UNKNOWN` is the initial/never-checked state, never a guess.
 */
export const DNS_CHECK_STATUSES = ["PASS", "FAIL", "MISSING", "UNKNOWN", "ERROR"] as const;
export type DnsCheckStatus = (typeof DNS_CHECK_STATUSES)[number];

/** DMARC's own three-value policy vocabulary (RFC 7489) — not this service's invention. */
export const DMARC_POLICIES = ["none", "quarantine", "reject"] as const;
export type DmarcPolicy = (typeof DMARC_POLICIES)[number];

export interface MxCheckResult {
  readonly status: DnsCheckStatus;
  readonly records: readonly string[];
}

export interface SpfCheckResult {
  readonly status: DnsCheckStatus;
  readonly record?: string;
}

/**
 * DKIM has no fixed, discoverable DNS location — its record lives at
 * `<selector>._domainkey.<domain>`, and the selector is chosen by whoever
 * configured the sending platform. `selector` is only present when a check
 * against a known-common selector (see infrastructure/node-dns-resolver.ts)
 * actually found a record; `PASS` never implies "DKIM is correctly
 * configured for every selector this domain might use" — only "at least one
 * commonly-used selector resolves."
 */
export interface DkimCheckResult {
  readonly status: DnsCheckStatus;
  readonly selector?: string;
}

/**
 * `policy` is only populated on `PASS`/`FAIL` (a record was found and
 * parsed) — never guessed when `MISSING`/`UNKNOWN`/`ERROR`. A DMARC record
 * existing, even with `policy: "reject"`, is not proof of deliverability by
 * itself (Stage 7 spec section 7) — it is one signal among several the risk
 * policy weighs.
 */
export interface DmarcCheckResult {
  readonly status: DnsCheckStatus;
  readonly policy?: DmarcPolicy;
  readonly record?: string;
}

export interface DomainAuthenticationAssessment {
  readonly domain: string;
  readonly mx: MxCheckResult;
  readonly spf: SpfCheckResult;
  readonly dkim: DkimCheckResult;
  readonly dmarc: DmarcCheckResult;
  readonly checkedAt: Date;
}
