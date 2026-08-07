import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DbModule } from './db/db.module';
import { ExportModule } from './export/export.module';
import { JobsModule } from './jobs/jobs.module';
import { NatsModule } from './nats/nats.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { UploadModule } from './upload/upload.module';

@Module({
  imports: [
    DbModule,
    NatsModule,
    PipelinesModule,
    JobsModule,
    ExportModule,
    UploadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
