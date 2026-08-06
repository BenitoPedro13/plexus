import path from 'node:path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DbService } from '../../src/db/db.service';

export interface TestDb {
  dbService: DbService;
  teardown: () => Promise<void>;
}

// Real Postgres via testcontainers, real generated migrations applied — no
// mocking the database, per CLAUDE.md's Tests section.
export async function setupTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:18.4-alpine',
  ).start();

  process.env.DATABASE_URL = container.getConnectionUri();
  const dbService = new DbService();

  await migrate(dbService.db, {
    migrationsFolder: path.join(__dirname, '../../drizzle/migrations'),
  });

  return {
    dbService,
    teardown: async () => {
      await dbService.onModuleDestroy();
      await container.stop();
    },
  };
}
