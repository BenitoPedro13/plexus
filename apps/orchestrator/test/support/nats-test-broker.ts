import { NatsContainer, StartedNatsContainer } from '@testcontainers/nats';
import { NatsService } from '../../src/nats/nats.service';

export interface TestBroker {
  natsService: NatsService;
  teardown: () => Promise<void>;
}

// Real NATS (JetStream enabled) via testcontainers, matching
// infra/docker-compose.yml's image — no mocking the queue, per CLAUDE.md's
// Tests section.
export async function setupTestBroker(): Promise<TestBroker> {
  const container: StartedNatsContainer = await new NatsContainer(
    'nats:2.14.4-alpine',
  )
    .withJetStream()
    .start();

  const { servers, user, pass } = container.getConnectionOptions();
  process.env.NATS_URL = Array.isArray(servers) ? servers[0] : servers;
  process.env.NATS_USER = user;
  process.env.NATS_PASS = pass;

  const natsService = new NatsService();
  await natsService.onModuleInit();

  return {
    natsService,
    teardown: async () => {
      await natsService.onModuleDestroy();
      await container.stop();
    },
  };
}
