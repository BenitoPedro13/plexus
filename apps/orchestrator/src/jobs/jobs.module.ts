import { Module } from '@nestjs/common';
import { JobDispatchService } from './job-dispatch.service';
import { JobResultConsumerService } from './job-result-consumer.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  controllers: [JobsController],
  providers: [JobsService, JobDispatchService, JobResultConsumerService],
  exports: [JobsService],
})
export class JobsModule {}
