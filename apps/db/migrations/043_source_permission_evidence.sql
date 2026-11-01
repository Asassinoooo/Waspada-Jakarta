-- 043_source_permission_evidence.sql
-- WJ-INT-02B: license-evidence columns on source_registry so model-use and
-- retention capabilities can be authorized against recorded evidence instead
-- of the free-form reuse_basis tokens alone.
-- Forward-only; never modifies 001-042. Grants unchanged; no data change:
-- existing rows get NULL and fail closed until populated.

ALTER TABLE waspada.source_registry
  ADD COLUMN IF NOT EXISTS reuse_license_url text NULL,
  ADD COLUMN IF NOT EXISTS reuse_scope text NULL,
  ADD COLUMN IF NOT EXISTS reuse_reviewer text NULL,
  ADD COLUMN IF NOT EXISTS reuse_reviewed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reuse_expires_at timestamptz NULL;
