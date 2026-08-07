import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConsumerMessages } from '@nats-io/jetstream';
import { DbService } from '../db/db.service';
import { JOB_RESULTS_SUBJECT, NatsService } from '../nats/nats.service';
import { JobDispatchService } from './job-dispatch.service';
import { handleStepResult } from './job-result-handler';

export const JOB_RESULTS_DURABLE_NAME = 'jobs-results';

@Injectable()
export class JobResultConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobResultConsumerService.name);
  private messages: ConsumerMessages | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly dbService: DbService,
    private readonly natsService: NatsService,
    private readonly jobDispatchService: JobDispatchService,
  ) {}

  async onModuleInit(): Promise<void> {
    const consumer = await this.natsService.durableConsumer(
      JOB_RESULTS_SUBJECT,
      JOB_RESULTS_DURABLE_NAME,
    );
    this.messages = await consumer.consume();
    this.loop = this.consume(this.messages);
  }

  async onModuleDestroy(): Promise<void> {
    this.messages?.stop();
    await this.loop;
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    for await (const message of messages) {
      try {
        await handleStepResult(
          this.dbService,
          this.jobDispatchService,
          message,
        );
      } catch (err) {
        // Left unacked on purpose: JetStream redelivers after AckWait, and
        // handleStepResult() is safe to re-run from scratch.
        this.logger.error(
          `Failed to process step result, leaving unacked for redelivery: ${(err as Error).message}`,
        );
      }
    }
  }
}
