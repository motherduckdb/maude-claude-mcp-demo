import { NextRequest, NextResponse } from 'next/server';
import { readOnlyQuery, healthCheck } from '@/lib/planetscale';

interface QueryRequest {
  sql: string;
  params?: unknown[];
  timeout?: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: QueryRequest = await request.json();
    const { sql, params, timeout } = body;

    if (!sql || typeof sql !== 'string') {
      return NextResponse.json(
        { error: 'SQL query is required' },
        { status: 400 }
      );
    }

    console.log('[DB API] Executing query:', sql.slice(0, 100) + (sql.length > 100 ? '...' : ''));

    const result = await readOnlyQuery(sql, params, { timeout });

    return NextResponse.json({
      success: true,
      data: {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields,
      },
    });
  } catch (error) {
    console.error('[DB API] Query error:', error);

    const message = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const isHealthy = await healthCheck();

    if (isHealthy) {
      return NextResponse.json({ status: 'healthy' });
    } else {
      return NextResponse.json(
        { status: 'unhealthy', error: 'Database connection failed' },
        { status: 503 }
      );
    }
  } catch (error) {
    console.error('[DB API] Health check error:', error);

    return NextResponse.json(
      { status: 'unhealthy', error: 'Health check failed' },
      { status: 503 }
    );
  }
}
