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
// partial → complete/failed", per-step). RUNNING -> PARTIAL is a genuinely
// terminal settlement (docs/tasks/TASK-branching-parallel-dags.md): a
// branching job where at least one branch COMPLETEs and at least one
// branch FAILS/is SKIPPED. A single-chain (Phase 1-style) pipeline can
// never reach PARTIAL — one step failing means zero steps completed, which
// still settles FAILED, unchanged from before branching existed. No
// automatic retry in Phase 1 (spec P1).
const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ['RUNNING'],
  RUNNING: ['PARTIAL', 'COMPLETE', 'FAILED'],
  PARTIAL: [],
  COMPLETE: [],
  FAILED: [],
};

// SKIPPED is produced by cascading a failed step's descendants (a DAG is
// fan-in-free/tree-shaped, so "descendants" is an unambiguous subtree) —
// see job-result-handler.ts's handleStepResult.
const JOB_STEP_TRANSITIONS: Record<JobStepStatus, readonly JobStepStatus[]> = {
  PENDING: ['RUNNING', 'SKIPPED'],
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
