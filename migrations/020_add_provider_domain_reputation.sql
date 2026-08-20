-- Stage 11: extends the existing mailbox-level reputation_assessments table
-- (see migrations/019_create_reputation_assessments.sql) with the
-- provider-level and domain-level reputation context computed as part of
-- the same assessment cycle (see reputation/README.md's Stage 11 section) —
-- reuses the same append-only table/history/API rather than creating two
-- new ones for what is, from a consumer's perspective, the same
-- "reputation evidence available when this mailbox was assessed."
--
-- Additive only — 001-019 are untouched. `DEFAULT '{}'::jsonb` only
-- protects against a NOT NULL violation on any pre-existing row at
-- migration time; this table has never held production traffic. Every row
-- inserted by the application from this point forward always supplies a
-- fully-formed snapshot for both columns (see
-- reputation/infrastructure/postgres-reputation-repository.ts).

ALTER TABLE reputation_assessments
  ADD COLUMN provider_reputation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN domain_reputation JSONB NOT NULL DEFAULT '{}'::jsonb;
