import { runMigrations } from './index';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not set; nothing to migrate.');
  process.exit(1);
}

try {
  await runMigrations(connectionString);
  console.log('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
}
