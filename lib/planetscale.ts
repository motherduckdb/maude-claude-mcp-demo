import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// PlanetScale PostgreSQL connection pool
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.PLANETSCALE_DATABASE_URL;

    if (!connectionString) {
      throw new Error('PLANETSCALE_DATABASE_URL environment variable is not set');
    }

    pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: true,
      },
      max: 10, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Handle pool errors
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  return pool;
}

export interface QueryOptions {
  timeout?: number; // Query timeout in milliseconds
}

export interface QueryResponse<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
  fields: Array<{
    name: string;
    dataTypeID: number;
  }>;
}

/**
 * Execute a SQL query against the PlanetScale database
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
  options?: QueryOptions
): Promise<QueryResponse<T>> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();

  try {
    // Set statement timeout if specified
    if (options?.timeout) {
      await client.query(`SET statement_timeout = ${options.timeout}`);
    }

    const result: QueryResult<T> = await client.query<T>(sql, params);

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
      fields: result.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
      })),
    };
  } finally {
    client.release();
  }
}

/**
 * Execute a read-only query (for safety)
 */
export async function readOnlyQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
  options?: QueryOptions
): Promise<QueryResponse<T>> {
  // Basic check to prevent write operations
  const normalizedSql = sql.trim().toUpperCase();
  const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE'];

  for (const keyword of writeKeywords) {
    if (normalizedSql.startsWith(keyword)) {
      throw new Error(`Write operations are not allowed. Query starts with: ${keyword}`);
    }
  }

  return query<T>(sql, params, options);
}

/**
 * Close the connection pool (for graceful shutdown)
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Check database connection health
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as health');
    return result.rows.length > 0;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}
