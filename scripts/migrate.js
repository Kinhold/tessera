import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required');
}

const migrationUrl = new URL('../migrations/001_initial.sql', import.meta.url);
const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(sql);
  console.log('Applied migrations/001_initial.sql');
} finally {
  await pool.end();
}
