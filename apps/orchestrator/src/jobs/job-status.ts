import { jobStatusEnum, jobStepStatusEnum } from '../db/schema';

export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
export type JobStepStatus = (typeof jobStepStatusEnum.enumValues)[number];

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: 'job' | 'jobStep',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

// Legal-transition table (spec's job state machine: "queued → running →
// partial → complete/failed", per-step). RUNNING -> PARTIAL exists so a job
// with more steps left can report partial progress; PARTIAL -> RUNNING lets
// the next step resume it. No automatic retry in Phase 1 (spec P1).
const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ['RUNNING'],
  RUNNING: ['PARTIAL', 'COMPLETE', 'FAILED'],
  PARTIAL: ['RUNNING'],
  COMPLETE: [],
  FAILED: [],
};

// SKIPPED is reserved for Phase 3 branching pipelines; nothing produces it
// while Phase 1 pipelines are linear-only, but it's kept in the enum so
// adding it later doesn't require a migration.
const JOB_STEP_TRANSITIONS: Record<JobStepStatus, readonly JobStepStatus[]> = {
  PENDING: ['RUNNING'],
  RUNNING: ['COMPLETE', 'FAILED'],
  COMPLETE: [],
  FAILED: [],
  SKIPPED: [],
};

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!JOB_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError('job', from, to);
  }
}

export function assertJobStepTransition(
  from: JobStepStatus,
  to: JobStepStatus,
): void {
  if (!JOB_STEP_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError('jobStep', from, to);
  }
}
