// HOSTED-19: Neon role-attribute compatibility for the hosted bootstrap.
//
// The layer-role migrations harden each role with
//   ALTER ROLE waspada_x NOLOGIN ... NOSUPERUSER ... NOREPLICATION NOBYPASSRLS;
// On PostgreSQL 16+ only a role that holds SUPERUSER, REPLICATION or BYPASSRLS may name that attribute
// in ALTER ROLE, even to turn it off. Neon's owner login holds none of them, so the statement fails with
// 42501. Applied migrations are checksum-guarded and must not be rewritten, so the bootstrap strips just
// those three "off" keywords from waspada ALTER ROLE statements as they are sent; the checksum is still
// computed on the unchanged file text. New roles are created without these attributes, and a login that
// lacks them cannot grant them, so the intent holds. verifyLayerRoleAttributes then checks every waspada
// role and fails closed if any of the three attributes is set.

import type { SqlExecutor } from "../../apps/db/src/sql.js";

const ALTER_WASPADA_ROLE = /ALTER\s+ROLE\s+waspada_[a-z0-9_]+\b[^;]*/giu;
const PRIVILEGED_OFF_KEYWORDS = /\s+NO(?:SUPERUSER|REPLICATION|BYPASSRLS)\b/giu;

/** Removes NOSUPERUSER, NOREPLICATION and NOBYPASSRLS from `ALTER ROLE waspada_*` statements only. */
export function stripPrivilegedRoleAttributes(sql: string): string {
  return sql.replace(ALTER_WASPADA_ROLE, (statement) => statement.replace(PRIVILEGED_OFF_KEYWORDS, ""));
}

/** Wraps an executor so execute() sends role statements a non-superuser login may run. */
export function withRoleAttributeCompat<T extends SqlExecutor>(executor: T): T {
  return new Proxy(executor, {
    get(target, property, receiver) {
      if (property === "execute") {
        return (statement: string) => target.execute(stripPrivilegedRoleAttributes(statement));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class RoleAttributeError extends Error {
  readonly code = "layer_role_privileged_attribute";
  readonly roles: readonly string[];
  constructor(roles: readonly string[]) {
    super(`layer_role_privileged_attribute: ${roles.join(", ")}`);
    this.name = "RoleAttributeError";
    this.roles = roles;
  }
}

/** Fails closed if any waspada role has SUPERUSER, REPLICATION or BYPASSRLS. */
export async function verifyLayerRoleAttributes(executor: Pick<SqlExecutor, "query">): Promise<number> {
  const result = await executor.query<{ rolname: string; rolsuper: boolean; rolreplication: boolean; rolbypassrls: boolean }>(
    "SELECT rolname, rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname LIKE 'waspada%' ORDER BY rolname",
  );
  const bad = result.rows.filter((row) => row.rolsuper || row.rolreplication || row.rolbypassrls).map((row) => row.rolname);
  if (bad.length > 0) throw new RoleAttributeError(bad);
  return result.rows.length;
}
