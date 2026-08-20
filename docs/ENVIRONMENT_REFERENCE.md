# Environment reference

Canonical catalog of environment variables **actually read by this repository**.
Placeholders only — never put production secrets in git.

Typed validation: `src/shared/config/schema.ts`, `src/shared/config/load-config.ts`.
Empty strings are treated as unset. When `NODE_ENV` is not `production`,
missing `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, and `API_KEY_PEPPER`
get development defaults from `src/shared/config/dev-defaults.ts`. Production
**must** set those four; missing values fail startup.

Every long-running process (API + four workers) loads the **same** schema and
requires Postgres **and** Redis connectivity at boot, even when a worker’s
tick path uses Postgres leases rather than Redis.

**Polling intervals** default as below and are now environment-configurable
(defaults preserve previous hardcoded values):

| Process | Env | Default |
|---|---|---|
| Warmup execution worker | `WARMUP_WORKER_POLL_INTERVAL_MS` | 30000 |
| Inbound poller | `INBOUND_WORKER_POLL_INTERVAL_MS` | 30000 |
| Classification worker | `CLASSIFICATION_WORKER_POLL_INTERVAL_MS` | 15000 |
| Policy worker | `POLICY_WORKER_POLL_INTERVAL_MS` | 15000 |

Provider **send** timeout is hardcoded (~15s per adapter). OAuth **refresh**
timeout is `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`.

Security: **secret** = never log / never commit. **public** = safe in logs.

---

## Runtime (API and workers)

| Name | Required | Default | Example (safe) | Security | API | Workers | Purpose |
|---|---|---|---|---|---|---|---|
| `NODE_ENV` | optional | `development` | `production` | public | yes | yes | Runtime mode. Production disables development secret defaults. Values: `development`, `test`, `production`. |
| `SERVICE_NAME` | optional | `skout-email-warmup-service` | `skout-email-warmup-service` | public | yes | yes | Health/log service name. Worker processes may suffix the name in logs. |
| `SERVICE_VERSION` | optional | `0.1.0` | `1.0.0` | public | yes | yes | Reported on `GET /health`. |
| `PORT` | optional | `3010` | `3010` | public | **yes** | no | HTTP listen port. Workers do not bind HTTP. |
| `HTTP_HOST` | optional | `0.0.0.0` | `0.0.0.0` | public | **yes** | no | Listen address. |
| `HTTP_BODY_LIMIT_BYTES` | optional (min 1024) | `1048576` | `1048576` | public | **yes** | no | Max JSON/body size. |
| `HTTP_SHUTDOWN_TIMEOUT_MS` | optional (min 1000) | `15000` | `15000` | public | **yes** | no | Forced exit if drain exceeds this. |
| `LOG_LEVEL` | optional | `info` | `info` | public | yes | yes | Pino level: `fatal` `error` `warn` `info` `debug` `trace` `silent`. |
| `DATABASE_URL` | **required in production** | none (dev default localhost:5433) | `postgresql://warmup:changeme@db:5432/skout_warmup` | **secret** | yes | yes | Postgres connection string (`postgres://` or `postgresql://`). |
| `REDIS_URL` | **required in production** | none (dev default localhost:6380) | `rediss://default:changeme@redis:6379` | **secret** | yes | yes | Redis (`redis://` or `rediss://`). OAuth state, mailbox connection locks, DNS cache, assessment invalidation. **Not a job queue.** |
| `DB_POOL_MIN` | optional | `2` | `2` | public | yes | yes | Pool min. Must be ≤ `DB_POOL_MAX`. |
| `DB_POOL_MAX` | optional | `10` | `10` | public | yes | yes | Pool max. |
| `DB_CONNECTION_TIMEOUT_MS` | optional | `5000` | `5000` | public | yes | yes | Pool connect timeout. |
| `DB_IDLE_TIMEOUT_MS` | optional | `30000` | `30000` | public | yes | yes | Pool idle timeout. |
| `DB_STATEMENT_TIMEOUT_MS` | optional | `30000` | `30000` | public | yes | yes | `SET statement_timeout` on each new pool client. `0` disables. |
| `ENCRYPTION_KEY` | **required in production** (≥32 chars) | none (dev-only placeholder) | `replace-with-32-plus-char-secret` | **secret** | yes | yes | Encrypts stored mailbox/provider credentials. |
| `API_KEY_PEPPER` | **required in production** (≥32 chars) | none (dev-only placeholder) | `replace-with-32-plus-char-pepper` | **secret** | yes | yes | HMAC pepper for tenant API-key hashing. |
| `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS` | optional (min 1000) | `10000` | `10000` | public | yes | yes (warmup/inbound/send paths that refresh OAuth) | Abort budget for OAuth access-token refresh. Independent of the 15s send timeout. |

---

## Provider OAuth (mailbox connect)

All-or-nothing per provider. Leave the whole group unset if that provider
will never be connected. A half-configured group **fails startup**.

| Name | Required | Default | Example | Security | API | Workers | Purpose |
|---|---|---|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | optional (group) | unset | `xxxxx.apps.googleusercontent.com` | public | yes | refresh paths | Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | optional (group) | unset | `changeme` | **secret** | yes | refresh paths | Google OAuth client secret. |
| `GOOGLE_REDIRECT_URI` | optional (group) | unset | `https://warmup.example/api/v1/oauth/google/callback` | public | yes | no | Must match Google console. |
| `MICROSOFT_CLIENT_ID` | optional (group) | unset | UUID | public | yes | refresh paths | Microsoft Entra application id. |
| `MICROSOFT_CLIENT_SECRET` | optional (group) | unset | `changeme` | **secret** | yes | refresh paths | Microsoft client secret. |
| `MICROSOFT_REDIRECT_URI` | optional (group) | unset | `https://warmup.example/api/v1/oauth/microsoft/callback` | public | yes | no | Must match Entra. |

SMTP/IMAP has no OAuth env group. SMTP/IMAP **send** is not implemented.

---

## Conversation classification (optional AI)

Deterministic classification always runs. HTTP AI is off unless
`AI_CLASSIFICATION_PROVIDER` is not `none`.

| Name | Required | Default | Example | Security | API | Workers | Purpose |
|---|---|---|---|---|---|---|---|
| `AI_CLASSIFICATION_PROVIDER` | optional | `none` | `none` | public | loaded | **classification** | `none` \| `openai` \| `openrouter`. |
| `AI_API_KEY` | required if provider ≠ `none` | unset | `sk-placeholder` | **secret** | loaded | **classification** | Provider API key. Never log. |
| `AI_BASE_URL` | optional | OpenAI or OpenRouter URL | `https://api.openai.com/v1` | public | loaded | **classification** | Override chat-completions base. Defaults: OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`. |
| `AI_MODEL` | optional | `gpt-4.1-mini` | `gpt-4.1-mini` | public | loaded | **classification** | Model name. |
| `AI_CLASSIFICATION_TIMEOUT_MS` | optional (min 1000) | `15000` | `15000` | public | loaded | **classification** | HTTP timeout for classifier. |
| `AI_MAX_INPUT_CHARS` | optional (min 256) | `8000` | `8000` | public | loaded | **classification** | Max chars sent to the model. |
| `AI_MAX_OUTPUT_CHARS` | optional (min 256) | `2000` | `2000` | public | loaded | **classification** | Max chars accepted from the model. |
| `AI_CLASSIFIER_VERSION` | optional | `conversation-classifier/v1` | `conversation-classifier/v1` | public | loaded | **classification** | Stored on classification rows. |
| `CLASSIFICATION_TAXONOMY_VERSION` | optional | `classification-taxonomy/v1` | `classification-taxonomy/v1` | public | loaded | **classification** | Stored on classification rows. |
| `AI_CLASSIFICATION_SUPPLEMENT` | optional | `false` | `false` | public | loaded | **classification** | `true`/`false`: AI may supplement deterministic labels. |

API and inbound processes load these fields but do not call the AI provider
unless the classification worker is running.

---

## Conversation policy versions

| Name | Required | Default | Example | Security | API | Workers | Purpose |
|---|---|---|---|---|---|---|---|
| `CONVERSATION_POLICY_VERSION` | optional | `conversation-policy/v1` | `conversation-policy/v1` | public | loaded | **policy** | Label on signals/events. Does not by itself change policy semantics. |
| `CONVERSATION_POLICY_TAXONOMY_VERSION` | optional | `conversation-policy-taxonomy/v1` | `conversation-policy-taxonomy/v1` | public | loaded | **policy** | Policy taxonomy label. |

---

## Warmup network (Stage 20 schema / Stage 21 ops, recipient routing)

Default **off**: warmup still self-sends and does not query network tables.
Setting `WARMUP_NETWORK_ROUTING_MODE=off` is an instant disable (no DB
lookup). These settings are not secrets. They do not change warmup volume
or safety-gate. Empty tables still mean there is no live partner fleet.

| Name | Required | Default | Example | Security | API | Workers | Purpose |
|---|---|---|---|---|---|---|---|
| `WARMUP_NETWORK_ROUTING_MODE` | optional | `off` | `off` | public | yes | **warmup send** | `off` (self-send, no DB), `prefer` (route or self-send), `require` (fail closed). |
| `WARMUP_NETWORK_RECENT_INTERACTION_WINDOW_MS` | optional | `604800000` (7d) | `604800000` | public | yes | **warmup send** | Avoid recently used partners for this customer mailbox. |
| `WARMUP_NETWORK_DEFAULT_DAILY_CAPACITY` | optional | `50` | `50` | public | loaded | loaded | Ops default for new rows; eligibility uses per-row `daily_capacity`. |
| `WARMUP_NETWORK_MIN_HEALTH_SCORE` | optional (0–100) | `50` | `50` | public | yes | **warmup send** | Minimum domain/mailbox health to be eligible. |
| `WARMUP_NETWORK_COOLDOWN_MS` | optional | `3600000` | `3600000` | public | loaded | loaded | Ops documentation; eligibility uses row `cooldown_until`. |
| `WARMUP_NETWORK_REQUIRE_SPF` | optional | `true` | `true` | public | yes | **warmup send** | Require domain SPF `PASS`. |
| `WARMUP_NETWORK_REQUIRE_DKIM` | optional | `true` | `true` | public | yes | **warmup send** | Require domain DKIM `PASS`. |
| `WARMUP_NETWORK_REQUIRE_DMARC` | optional | `true` | `true` | public | yes | **warmup send** | Require domain DMARC `PASS`. |

## Warmup identity pools (Stage 20, sending mailbox)

Optional tenant pools for **which of the tenant’s own mailboxes** should receive the next allocation. Distinct from warmup-network recipient routing. Sessions stay per-mailbox. See `docs/WARMUP_POOL_ROTATION.md`.

| Name | Required | Default | Example | Security | API | Workers | Purpose |
|---|---|---|---|---|---|---|---|
| `WARMUP_POOL_SELECTION_STRATEGY` | optional | `health_first_least_used` | `least_used` | public | yes | loaded | Default strategy for new pools. |
| `WARMUP_MAX_DOMAIN_SHARE_PERCENT` | optional (1–100) | `70` | `70` | public | yes | loaded | Default domain-share ceiling for selection. |
| `WARMUP_MAX_CONSECUTIVE_SAME_DOMAIN` | optional | `2` | `2` | public | yes | loaded | Default consecutive same-domain cap. |
| `WARMUP_POOL_SELECTION_COOLDOWN_MS` | optional | `0` | `60000` | public | yes | loaded | Cooldown written to membership after select. |

---

## Tests only (never read by API/workers)

| Name | Required | Default | Example | Security | Purpose |
|---|---|---|---|---|---|
| `TEST_DATABASE_URL` | optional | `postgresql://postgres:postgres@localhost:5433/skout_warmup_test` | same | **secret** (local) | Isolated DB for `npm run test:db`. Created on demand. |
| `TEST_REDIS_URL` | optional | `redis://localhost:6380/1` | same | **secret** (local) | Isolated Redis logical DB 1 so tests do not `FLUSHDB` developer DB 0. |

---

## CLI only (`npm run certify:provider-send`)

Must **not** be set on ordinary API/worker deployments. See
`docs/PROVIDER_CERTIFICATION_RUNBOOK.md`.

| Name | Required to run CLI | Security | Purpose |
|---|---|---|---|
| `ALLOW_LIVE_PROVIDER_CERTIFICATION` | must equal `true` | public | Opt-in gate. |
| `CERTIFICATION_TENANT_ID` | yes | public (UUID) | Existing tenant. |
| `CERTIFICATION_MAILBOX_ID` | yes | public (UUID) | Existing mailbox. |
| `CERTIFICATION_RECIPIENT_EMAIL` | yes | PII | Recipient of the one certification message. |

---

## Docker Compose local only (not `loadConfig`)

`docker-compose.yml` host ports **5433** (Postgres) and **6380** (Redis).
Optional Compose overrides (not used by Node): `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `REDIS_PORT`.

---

## Unused / not an env var

Worker poll intervals **are** env vars (`*_WORKER_POLL_INTERVAL_MS`); see the table at the top of this document.

| Item | Status |
|---|---|
| `bullmq` | Not a dependency. Leases remain Postgres. |
| Integration publisher URL | Does not exist. Pull only. |
| OpenTelemetry exporter / OTLP | Does not exist. Process-local counters in `src/shared/observability/metrics.ts` plus pino logs. |
