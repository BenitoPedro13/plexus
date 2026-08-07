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

    this.logger.log(`Connected to NATS, stream "${PLEXUS_JOBS_STREAM}" ready`);
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
}
