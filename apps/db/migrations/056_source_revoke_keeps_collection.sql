-- 056_source_revoke_keeps_collection.sql
-- HOSTED-28 (owner decision, 18 Nov 2026; FR-16): revoking a source stops its publication only. Collection
-- (polling, triage and model use of its items) continues, because FR-16 needs no per-source approval to collect.
-- Approval gates public display and automatic publication, not collection.
-- The CHECK that tied auto_acquisition_enabled to approval is replaced. Collection now needs only an active
-- registry entry. The rule from 001_foundation stays: the auto-publication policy is `never` unless approval is
-- `approved`, so a revoked source still cannot publish automatically. Forward-only. No row changes: the new CHECK
-- is weaker than the old one, so every existing row still satisfies it.
ALTER TABLE waspada.source_registry
  DROP CONSTRAINT source_registry_auto_acquisition_eligible_check;

ALTER TABLE waspada.source_registry
  ADD CONSTRAINT source_registry_auto_acquisition_eligible_check
  CHECK (NOT auto_acquisition_enabled OR registry_status = 'active');
