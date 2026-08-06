import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DbModule } from './db/db.module';
import { JobsModule } from './jobs/jobs.module';
import { PipelinesModule } from './pipelines/pipelines.module';

@Module({
  imports: [DbModule, PipelinesModule, JobsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
