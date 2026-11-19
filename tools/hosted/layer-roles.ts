// HOSTED-03: the NOLOGIN layer roles created by migrations 001-062. The owner login is granted each one
// (WITH SET TRUE) so the hosted runtime can SET ROLE into them. The test checks this list against the
// CREATE ROLE statements in the migrations, so a new role cannot be added silently.

export const LAYER_ROLES: readonly string[] = [
  "waspada_public_reader",
  "waspada_l1_pipeline",
  "waspada_l2_grounding_reader",
  "waspada_l2_grounding_writer",
  "waspada_l2_proposal_writer",
  "waspada_l3_coordinator",
  "waspada_l4_publication_writer",
  "waspada_l4_moderator_publication_writer",
  "waspada_l4_freshness_writer",
  "waspada_l4_publication_outbox_delivery",
  "waspada_l4_report_revision_impact_reader",
  "waspada_l4_pipeline_flow_reader",
  "waspada_auth_service",
  "waspada_retention_purger",
];

export const LAYER_ROLE_NAME_PATTERN = /^waspada_[a-z0-9_]+$/u;

export interface LayerRoleDiff {
  /** Expected by the constant but absent from pg_roles. This is fatal: a migration did not run. */
  readonly missing: readonly string[];
  /** Present in pg_roles with the waspada_ prefix but not in the constant. Reported as a warning. */
  readonly unexpected: readonly string[];
}

export function diffLayerRoles(expected: readonly string[], present: readonly string[]): LayerRoleDiff {
  const want = new Set(expected);
  const have = new Set(present);
  return {
    missing: expected.filter((role) => !have.has(role)),
    unexpected: present.filter((role) => role.startsWith("waspada_") && !want.has(role)),
  };
}

/** Role names created by `CREATE ROLE waspada_...` in a migration file's text. */
export function roleCreationsIn(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(/CREATE\s+ROLE\s+(waspada_[a-z0-9_]+)/giu)) {
    names.push(match[1]!.toLowerCase());
  }
  return names;
}
