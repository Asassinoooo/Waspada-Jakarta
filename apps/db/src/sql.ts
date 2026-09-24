export interface SqlResult<Row> {
  readonly rows: readonly Row[];
}

/** Minimal SQL boundary used by the repositories and migration runner. */
export interface SqlExecutor {
  query<Row extends object = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  execute(statement: string): Promise<void>;
}
