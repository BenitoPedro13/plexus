import type { StepDto } from './dto/create-pipeline.dto';

export type LinearDagErrorReason =
  | 'DUPLICATE_STEP_ID'
  | 'MISSING_DEPENDENCY'
  | 'BRANCHING_NOT_SUPPORTED'
  | 'MULTIPLE_ROOTS'
  | 'CYCLE_DETECTED';

export class LinearDagValidationError extends Error {
  constructor(
    public readonly reason: LinearDagErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'LinearDagValidationError';
  }
}

/**
 * Enforces Phase 1's "linear (non-branching) pipelines only" (spec "Suggested
 * Phasing"). A valid pipeline is a single chain: exactly one root (no
 * dependsOn), every other step depends on exactly one prior step, and no step
 * is depended on by more than one other step. Returns steps in resolved
 * execution order (root first). Replaced by real DAG resolution in Phase 3.
 */
export function resolveLinearOrder(steps: StepDto[]): StepDto[] {
  if (steps.length === 0) {
    return [];
  }

  const byId = new Map<string, StepDto>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new LinearDagValidationError(
        'DUPLICATE_STEP_ID',
        `Duplicate step id "${step.id}"`,
      );
    }
    byId.set(step.id, step);
  }

  // Map from a step's id to the id of the single step that depends on it
  // (its "child" in the chain). A second incoming edge to the same id means
  // branching.
  const childOf = new Map<string, string>();
  let root: StepDto | undefined;

  for (const step of steps) {
    const dependsOn = step.dependsOn ?? [];

    if (dependsOn.length === 0) {
      if (root) {
        throw new LinearDagValidationError(
          'MULTIPLE_ROOTS',
          `Multiple root steps found ("${root.id}" and "${step.id}") — Phase 1 pipelines must be a single linear chain`,
        );
      }
      root = step;
      continue;
    }

    if (dependsOn.length > 1) {
      throw new LinearDagValidationError(
        'BRANCHING_NOT_SUPPORTED',
        `Step "${step.id}" depends on multiple steps (${dependsOn.join(', ')}) — branching pipelines are not supported until Phase 3`,
      );
    }

    const [parentId] = dependsOn;
    if (!byId.has(parentId)) {
      throw new LinearDagValidationError(
        'MISSING_DEPENDENCY',
        `Step "${step.id}" depends on unknown step "${parentId}"`,
      );
    }

    if (childOf.has(parentId)) {
      throw new LinearDagValidationError(
        'BRANCHING_NOT_SUPPORTED',
        `Step "${parentId}" has more than one dependent step ("${childOf.get(parentId)}" and "${step.id}") — branching pipelines are not supported until Phase 3`,
      );
    }
    childOf.set(parentId, step.id);
  }

  if (!root) {
    // Every step has exactly one (existing, non-branching) dependency, so
    // there is no entry point — with a finite step set that's only possible
    // if the steps form a cycle among themselves.
    throw new LinearDagValidationError(
      'CYCLE_DETECTED',
      'No root step found — every step has a dependsOn, which means the steps form a cycle',
    );
  }

  const ordered: StepDto[] = [root];
  const visited = new Set<string>([root.id]);
  let currentId = root.id;

  while (childOf.has(currentId)) {
    const nextId = childOf.get(currentId)!;
    if (visited.has(nextId)) {
      throw new LinearDagValidationError(
        'CYCLE_DETECTED',
        `Cycle detected involving step "${nextId}"`,
      );
    }
    const next = byId.get(nextId)!;
    ordered.push(next);
    visited.add(nextId);
    currentId = nextId;
  }

  if (ordered.length !== steps.length) {
    const unreached = steps.filter((s) => !visited.has(s.id)).map((s) => s.id);
    throw new LinearDagValidationError(
      'CYCLE_DETECTED',
      `Step(s) not reachable from root "${root.id}": ${unreached.join(', ')} — likely a disconnected cycle`,
    );
  }

  return ordered;
}
