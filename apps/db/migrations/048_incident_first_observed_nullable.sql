-- 048_incident_first_observed_nullable.sql
-- F-14: an incident's first_observed_at is the source's event time. When a report gives no event
-- time it stays NULL, and the publish time, the processing time and "now" are never stored there.
-- Forward-only. It changes only the NOT NULL constraint on this one column; 001-047 are untouched.
ALTER TABLE waspada.incidents
  ALTER COLUMN first_observed_at DROP NOT NULL;
