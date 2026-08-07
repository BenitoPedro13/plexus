import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { nanos } from '@nats-io/nats-core';
import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  type Consumer,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';

export const PLEXUS_JOBS_STREAM = 'PLEXUS_JOBS';
export const JOB_DISPATCH_SUBJECT = 'plexus.jobs.dispatch';
export const JOB_RESULTS_SUBJECT = 'plexus.jobs.results';

// A *separate* stream from PLEXUS_JOBS_STREAM, deliberately not another
// subject under `plexus.jobs.>`: JetStream subjects can only belong to one
// stream at a time (confirmed: nats-io/nats-server "subjects overlap with
// an existing stream" / JSStreamSubjectOverlapErr), so progress events need
// their own disjoint prefix. Limits retention (not PLEXUS_JOBS_STREAM's
// Workqueue) because a Workqueue stream only allows *disjoint* consumer
// filter subjects (confirmed: nats-io/nats-server issue #3639 / discussion
// #3637) — two browser tabs (or a reconnect racing its predecessor's
// cleanup) both watching the same job would need two consumers filtered to
// the very same subject, which Workqueue retention rejects.
export const PLEXUS_JOB_EVENTS_STREAM = 'PLEXUS_JOB_EVENTS';
export const JOB_EVENTS_SUBJECT_PREFIX = 'plexus.events.jobs';

// First-pass default, not researched: long enough that a client
// reconnecting shortly after a job settles still finds its final events,
// short enough that a busy instance doesn't accumulate per-job event
// history indefinitely. See docs/90-deferred-register.md.
const JOB_EVENTS_MAX_AGE_MILLIS = 10 * 60 * 1000;

export function jobEventsSubject(jobId: string): string {
  return `${JOB_EVENTS_SUBJECT_PREFIX}.${jobId}`;
}

export interface DurableConsumerOptions {
  ackWaitMillis?: number;
}

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsService.name);
  private connection!: NatsConnection;
  private client!: JetStreamClient;
  private manager!: JetStreamManager;

  async onModuleInit(): Promise<void> {
    // NATS_USER/NATS_PASS are optional and unused against
    // infra/docker-compose.yml's unauthenticated local NATS — they exist so
    // testcontainers-provisioned brokers (which default to requiring auth)
    // can be reached without embedding credentials in the server URL, which
    // this client's server-string parser mishandles (userinfo containing a
    // second `:` gets misdetected as an IPv6 literal).
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://localhost:4222',
      user: process.env.NATS_USER,
      pass: process.env.NATS_PASS,
    });
    this.manager = await jetstreamManager(this.connection);
    this.client = jetstream(this.connection);

    // Idempotent: the server accepts a repeat STREAM.CREATE for an existing
    // stream whose config matches, same semantics nats.go documents for
    // Go's jetstream.CreateStream().
    await this.manager.streams.add({
      name: PLEXUS_JOBS_STREAM,
      subjects: ['plexus.jobs.>'],
      retention: RetentionPolicy.Workqueue,
    });

    await this.manager.streams.add({
      name: PLEXUS_JOB_EVENTS_STREAM,
      subjects: [`${JOB_EVENTS_SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      max_age: nanos(JOB_EVENTS_MAX_AGE_MILLIS),
    });

    this.logger.log(
      `Connected to NATS, streams "${PLEXUS_JOBS_STREAM}"/"${PLEXUS_JOB_EVENTS_STREAM}" ready`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.drain();
  }

  async publish(subject: string, payload: unknown): Promise<void> {
    await this.client.publish(subject, JSON.stringify(payload));
  }

  // Creates a durable pull consumer filtered to `subject` if it doesn't
  // already exist, then returns a handle for consume()/fetch()/next().
  // `consumers.add()`'s default action errors on an existing durable name
  // (unlike streams.add()), so existence is checked explicitly first.
  async durableConsumer(
    subject: string,
    durableName: string,
    opts: DurableConsumerOptions = {},
  ): Promise<Consumer> {
    try {
      await this.manager.consumers.info(PLEXUS_JOBS_STREAM, durableName);
    } catch (err) {
      if (
        err instanceof JetStreamApiError &&
        err.code === JetStreamApiCodes.ConsumerNotFound
      ) {
        await this.manager.consumers.add(PLEXUS_JOBS_STREAM, {
          durable_name: durableName,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          filter_subject: subject,
          ...(opts.ackWaitMillis !== undefined
            ? { ack_wait: nanos(opts.ackWaitMillis) }
            : {}),
        });
      } else {
        throw err;
      }
    }

    return this.client.consumers.get(PLEXUS_JOBS_STREAM, durableName);
  }

  // One ephemeral pull consumer per SSE connection (JobsService.streamEvents),
  // filtered to a single job's events. No `durable_name` — per
  // @nats-io/jetstream's own ConsumerConfig type, "Set `name` for ephemeral
  // consumers" — since a durable name would collide across two concurrent
  // connections watching the same job. AckPolicy.None: these are
  // fire-and-forget progress notifications, not work that needs redelivery
  // tracking. `inactive_threshold` is a server-side safety net that deletes
  // the consumer if the owning connection's own teardown (see
  // JobsService.streamEvents) never runs, e.g. an ungraceful process exit.
  async ephemeralJobEventsConsumer(jobId: string): Promise<Consumer> {
    const name = `sse-${crypto.randomUUID()}`;
    await this.manager.consumers.add(PLEXUS_JOB_EVENTS_STREAM, {
      name,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.New,
      filter_subject: jobEventsSubject(jobId),
      inactive_threshold: nanos(60_000),
    });
    return this.client.consumers.get(PLEXUS_JOB_EVENTS_STREAM, name);
  }
}
