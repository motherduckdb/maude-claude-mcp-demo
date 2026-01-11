import { Pool } from 'pg';

async function initializeDatabase() {
  const connectionString = process.env.PLANETSCALE_DATABASE_URL;

  if (!connectionString) {
    console.error('Error: PLANETSCALE_DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  // Extract database name from connection string
  const dbNameMatch = connectionString.match(/\/([^/?]+)(\?|$)/);
  const dbName = dbNameMatch ? dbNameMatch[1] : null;

  if (!dbName) {
    console.error('Error: Could not extract database name from connection string');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: true,
    },
  });

  let client;
  try {
    console.log(`Connecting to database "${dbName}"...`);
    client = await pool.connect();
  } catch (error: unknown) {
    // Check if database doesn't exist (error code 3D000)
    if (error && typeof error === 'object' && 'code' in error && error.code === '3D000') {
      console.log(`Database "${dbName}" does not exist. Creating it...`);

      // Connect to default postgres database
      const defaultConnectionString = connectionString.replace(`/${dbName}`, '/postgres');
      const defaultPool = new Pool({
        connectionString: defaultConnectionString,
        ssl: {
          rejectUnauthorized: true,
        },
      });

      try {
        const defaultClient = await defaultPool.connect();
        await defaultClient.query(`CREATE DATABASE "${dbName}"`);
        console.log(`Database "${dbName}" created successfully.`);
        defaultClient.release();
        await defaultPool.end();

        // Now connect to the newly created database
        console.log(`Connecting to newly created database "${dbName}"...`);
        client = await pool.connect();
      } catch (createError) {
        console.error('Failed to create database:', createError);
        await defaultPool.end();
        process.exit(1);
      }
    } else {
      throw error;
    }
  }

  try {

    console.log('Creating shares table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS shares (
        id VARCHAR(255) PRIMARY KEY,
        html_content TEXT NOT NULL,
        model VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );
    `);

    // Add model column if it doesn't exist (for existing tables)
    console.log('Ensuring model column exists...');
    await client.query(`
      ALTER TABLE shares ADD COLUMN IF NOT EXISTS model VARCHAR(255);
    `);

    console.log('Creating index on id column...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shares_id ON shares(id);
    `);

    console.log('Creating index on expires_at for cleanup queries...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at);
    `);

    console.log('Database initialization complete!');
    client.release();
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initializeDatabase();
