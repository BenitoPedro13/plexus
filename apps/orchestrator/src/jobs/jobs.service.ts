import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import {
  jobs,
  jobSteps,
  pipelines,
  type Job,
  type JobStep,
} from '../db/schema';
import { CreateBatchJobDto } from './dto/create-batch-job.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { JobDispatchService } from './job-dispatch.service';
import type { JobStatus, JobStepStatus } from './job-status';
import {
  transitionJobStatus,
  transitionJobStepStatus,
} from './job-transitions';

export interface JobWithSteps extends Job {
  steps: JobStep[];
}

@Injectable()
export class JobsService {
  constructor(
    private readonly dbService: DbService,
    private readonly jobDispatchService: JobDispatchService,
  ) {}

  async create(dto: CreateJobDto): Promise<JobWithSteps> {
    const [pipeline] = await this.dbService.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, dto.pipelineId));

    if (!pipeline) {
      throw new NotFoundException(`Pipeline "${dto.pipelineId}" not found`);
    }

    const created = await this.dbService.db.transaction(async (tx) => {
      const [job] = await tx
        .insert(jobs)
        .values({
          pipelineId: pipeline.id,
          inputRef: dto.inputRef,
          status: 'QUEUED',
        })
        .returning();

      const steps =
        pipeline.definition.length > 0
          ? await tx
              .insert(jobSteps)
              .values(
                pipeline.definition.map((step, index) => ({
                  jobId: job.id,
                  stepId: step.id,
                  processor: step.processor,
                  params: step.params,
                  order: index,
                  status: 'PENDING' as const,
                })),
              )
              .returning()
          : [];

      return { ...job, steps: steps.sort((a, b) => a.order - b.order) };
    });

    // Dispatch happens after the transaction commits: a NATS publish can't
    // be rolled back if the surrounding transaction later aborts. It
    // mutates job/step status, so re-fetch rather than returning the
    // pre-dispatch snapshot captured above.
    await this.jobDispatchService.dispatchNext(created.id);

    return this.findOne(created.id);
  }

  // Creates one `jobs` row per inputRef against the same pipeline — "apply
  // this recipe to N files" as a single atomic-ish operation instead of N
  // independent client calls to create(). All N jobs + their steps are
  // inserted inside one transaction (proven safe by create()'s existing
  // single-job/N-step transaction above — a drizzle-orm/node-postgres
  // transaction callback runs its queries on one held connection
  // regardless of how many inserts happen inside it, so looping over
  // inputRefs inside the same `tx` needs no new transaction API). Dispatch
  // is still one `dispatchNext` call per job, after commit, for the same
  // reason create() defers it: a NATS publish can't be rolled back.
  async createBatch(dto: CreateBatchJobDto): Promise<JobWithSteps[]> {
    const [pipeline] = await this.dbService.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, dto.pipelineId));

    if (!pipeline) {
      throw new NotFoundException(`Pipeline "${dto.pipelineId}" not found`);
    }

    const created = await this.dbService.db.transaction(async (tx) => {
      const results: JobWithSteps[] = [];

      for (const inputRef of dto.inputRefs) {
        const [job] = await tx
          .insert(jobs)
          .values({
            pipelineId: pipeline.id,
            inputRef,
            status: 'QUEUED',
          })
          .returning();

        const steps =
          pipeline.definition.length > 0
            ? await tx
                .insert(jobSteps)
                .values(
                  pipeline.definition.map((step, index) => ({
                    jobId: job.id,
                    stepId: step.id,
                    processor: step.processor,
                    params: step.params,
                    order: index,
                    status: 'PENDING' as const,
                  })),
                )
                .returning()
            : [];

        results.push({
          ...job,
          steps: steps.sort((a, b) => a.order - b.order),
        });
      }

      return results;
    });

    for (const job of created) {
      await this.jobDispatchService.dispatchNext(job.id);
    }

    return Promise.all(created.map((job) => this.findOne(job.id)));
  }

  async findOne(id: string): Promise<JobWithSteps> {
    const [job] = await this.dbService.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id));

    if (!job) {
      throw new NotFoundException(`Job "${id}" not found`);
    }

    const steps = await this.dbService.db
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.jobId, id))
      .orderBy(asc(jobSteps.order));

    return { ...job, steps };
  }

  async transitionJob(id: string, to: JobStatus): Promise<Job> {
    return transitionJobStatus(this.dbService.db, id, to);
  }

  async transitionStep(id: string, to: JobStepStatus): Promise<JobStep> {
    return transitionJobStepStatus(this.dbService.db, id, to);
  }
}
