# Delivery Events

**Responsibility**: ingestion and normalization of delivery-related events
(bounces, delivery failures, throttling signals, provider webhooks/polling
results) into the `delivery_events` table — the raw evidence stream that
`health` and `risk` compute over.

**Boundary**:
- This module records what happened; it does not interpret what it means for
  health/risk/policy — that interpretation belongs downstream. Keeps the
  evidence trail auditable and decoupled from the scoring logic that consumes it.

**Target stage**: Stage 10.
