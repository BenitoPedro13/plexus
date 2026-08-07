import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    this.db = drizzle(this.pool, { schema });
  }

  // Applies any pending migrations against a real running app's own
  // database on startup -- previously only test/support/postgres-test-db.ts
  // did this (for testcontainers-provisioned Postgres), so a fresh
  // docker-compose Postgres volume with no test infra involved had no
  // tables at all until `drizzle-kit migrate` was run by hand
  // (docs/90-deferred-register.md D-44). CWD-relative, not __dirname-
  // relative, matching drizzle.config.ts's own convention (`out:
  // './drizzle/migrations'`) -- __dirname would differ between ts-jest
  // (running from src/db) and the compiled build (dist/src/db), while CWD
  // is apps/orchestrator either way `nest start`/`pnpm test`/`start:prod`
  // are invoked. Idempotent: drizzle's migrator tracks applied migrations
  // in its own bookkeeping table, safe to call on every startup.
  async onModuleInit(): Promise<void> {
    await migrate(this.db, { migrationsFolder: 'drizzle/migrations' });
    this.logger.log('Migrations applied');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
