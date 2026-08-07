// Plain JSON message shapes crossing the orchestrator (TS) <-> worker (Go)
// boundary over NATS. Hand-duplicated on the Go side in
// workers/internal/dispatch/message.go — see docs/90-deferred-register.md
// for why (proto/ isn't scaffolded until Phase 4).

export interface StepDispatchMessage {
  jobId: string;
  jobStepId: string;
  stepId: string;
  processor: string;
  params: Record<string, unknown>;
  inputRef: string;
  order: number;
}

export interface StepResultMessage {
  jobId: string;
  jobStepId: string;
  status: 'complete' | 'failed';
  outputRef?: string;
  error?: string;
}
