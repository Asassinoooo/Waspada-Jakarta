-- 058_source_display_names.sql
-- HOSTED-36 (owner decision, 18 Nov 2026): the BMKG and PetaBencana registry rows were seeded with their source id as
-- display_name, so the public outlet name read "source-bmkg-gempa" and "petabencana". The seeds and lazy inserts now write
-- the names in apps/worker/src/runtime/structured-source-display.ts. This migration corrects the rows that already exist.
-- It changes a row only while its display_name still equals its source id, so an owner-chosen name is never overwritten.
-- Forward-only and idempotent: a second run matches no row. source_registry has no append-only trigger.
-- Published attribution rows (public_attribution_review_decisions) are append-only and keep the name they were written
-- with. This migration does not touch them.
UPDATE waspada.source_registry
   SET display_name = 'BMKG'
 WHERE source_id = 'source-bmkg-gempa'
   AND display_name = 'source-bmkg-gempa';

UPDATE waspada.source_registry
   SET display_name = 'PetaBencana.id'
 WHERE source_id = 'petabencana'
   AND display_name = 'petabencana';
