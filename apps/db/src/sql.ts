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

/** Runs a unit of SQL work using one transaction-bound executor. */
export interface SqlTransactionRunner {
  transaction<Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result>;
}

/** SQL access that also provides an atomic transaction boundary. */
export type TransactionalSqlExecutor = SqlExecutor & SqlTransactionRunner;
