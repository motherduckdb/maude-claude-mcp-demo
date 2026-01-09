import { createMcpClient, executeTool, closeMcpClient } from '../lib/mcp-client';
import { writeFileSync } from 'fs';
import { join } from 'path';

async function generateMetadata() {
  console.log('Connecting to MotherDuck...');
  const client = await createMcpClient();

  try {
    // Get list of tables
    console.log('\n--- TABLES ---');
    const tablesResult = await executeTool(client, 'list_tables', { database: 'eastlake' });
    console.log(tablesResult);

    // Parse table names from JSON result
    const tablesData = JSON.parse(tablesResult);
    const tables: string[] = tablesData.tables?.map((t: { name: string }) => t.name) || [];

    console.log('\nFound tables:', tables);

    // Get columns for each table
    const tableSchemas: Record<string, string> = {};
    for (const table of tables) {
      console.log(`\n--- COLUMNS FOR ${table} ---`);
      const columnsResult = await executeTool(client, 'list_columns', {
        database: 'eastlake',
        table: table
      });
      console.log(columnsResult);
      tableSchemas[table] = columnsResult;
    }

    // Get sample data and row counts
    console.log('\n--- ROW COUNTS ---');
    const countQueries = tables.map(t => `SELECT '${t}' as table_name, COUNT(*) as row_count FROM eastlake.${t}`).join(' UNION ALL ');
    const countsResult = await executeTool(client, 'query', {
      database: 'eastlake',
      sql: countQueries
    });
    console.log(countsResult);

    // Get sample queries to understand relationships
    console.log('\n--- SAMPLE CUSTOMER DATA ---');
    const customerSample = await executeTool(client, 'query', {
      database: 'eastlake',
      sql: 'SELECT * FROM eastlake.customers LIMIT 3'
    });
    console.log(customerSample);

    console.log('\n--- SAMPLE PRODUCT DATA ---');
    const productSample = await executeTool(client, 'query', {
      database: 'eastlake',
      sql: 'SELECT * FROM eastlake.products LIMIT 3'
    });
    console.log(productSample);

    console.log('\n--- SAMPLE ORDER DATA ---');
    const orderSample = await executeTool(client, 'query', {
      database: 'eastlake',
      sql: 'SELECT * FROM eastlake.orders LIMIT 3'
    });
    console.log(orderSample);

    // Check for order_items or similar
    console.log('\n--- CHECKING FOR ORDER DETAILS ---');
    try {
      const orderDetailsSample = await executeTool(client, 'query', {
        database: 'eastlake',
        sql: 'SELECT * FROM eastlake.order_items LIMIT 3'
      });
      console.log(orderDetailsSample);
    } catch (e) {
      console.log('order_items table not found, trying alternatives...');
      try {
        const lineItems = await executeTool(client, 'query', {
          database: 'eastlake',
          sql: 'SELECT * FROM eastlake.line_items LIMIT 3'
        });
        console.log(lineItems);
      } catch (e2) {
        console.log('No line items table found');
      }
    }

    // Output all results
    console.log('\n\n=== FULL OUTPUT FOR METADATA ===\n');
    console.log('Tables:', tablesResult);
    console.log('\nTable Schemas:');
    for (const [table, schema] of Object.entries(tableSchemas)) {
      console.log(`\n${table}:\n${schema}`);
    }
    console.log('\nRow Counts:', countsResult);

  } finally {
    await closeMcpClient(client);
  }
}

generateMetadata().catch(console.error);
