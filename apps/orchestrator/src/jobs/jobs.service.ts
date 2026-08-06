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
import { CreateJobDto } from './dto/create-job.dto';
import {
  assertJobStepTransition,
  assertJobTransition,
  type JobStatus,
  type JobStepStatus,
} from './job-status';

export interface JobWithSteps extends Job {
  steps: JobStep[];
}

@Injectable()
export class JobsService {
  constructor(private readonly dbService: DbService) {}

  async create(dto: CreateJobDto): Promise<JobWithSteps> {
    const [pipeline] = await this.dbService.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, dto.pipelineId));

    if (!pipeline) {
      throw new NotFoundException(`Pipeline "${dto.pipelineId}" not found`);
    }

    return this.dbService.db.transaction(async (tx) => {
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
    const [current] = await this.dbService.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id));
    if (!current) {
      throw new NotFoundException(`Job "${id}" not found`);
    }

    assertJobTransition(current.status, to);

    const [updated] = await this.dbService.db
      .update(jobs)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(jobs.id, id))
      .returning();

    return updated;
  }

  async transitionStep(id: string, to: JobStepStatus): Promise<JobStep> {
    const [current] = await this.dbService.db
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.id, id));
    if (!current) {
      throw new NotFoundException(`Job step "${id}" not found`);
    }

    assertJobStepTransition(current.status, to);

    const now = new Date();
    const [updated] = await this.dbService.db
      .update(jobSteps)
      .set({
        status: to,
        startedAt: to === 'RUNNING' ? now : current.startedAt,
        completedAt:
          to === 'COMPLETE' || to === 'FAILED' ? now : current.completedAt,
      })
      .where(eq(jobSteps.id, id))
      .returning();

    return updated;
  }
}
