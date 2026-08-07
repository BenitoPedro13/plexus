import type { StepDto } from './dto/create-pipeline.dto';

export type DagErrorReason =
  | 'DUPLICATE_STEP_ID'
  | 'MISSING_DEPENDENCY'
  | 'FAN_IN_NOT_SUPPORTED'
  | 'CYCLE_DETECTED';

export class DagValidationError extends Error {
  constructor(
    public readonly reason: DagErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'DagValidationError';
  }
}

export interface ResolvedStep {
  id: string;
  processor: StepDto['processor'];
  params: Record<string, unknown>;
  dependsOn: string[];
}

/**
 * Resolves a pipeline's steps into a real DAG (`docs/tasks/TASK-branching-parallel-dags.md`,
 * replacing the old single-chain-only `resolveLinearOrder`). Two supported shapes:
 *
 * - **Implicit chain**: when *every* step in the pipeline omits `dependsOn` entirely, each
 *   step implicitly depends on the immediately preceding array entry (the first is a root).
 *   This is a whole-pipeline mode, not a per-step default — it's what keeps a
 *   `dependsOn`-less recipe (see `@plexus/recipe` — recipes never set this field by design)
 *   behaving as a strict linear chain with no translation step, fixing the real "Apply to
 *   Batch on a multi-step recipe" bug the task doc's "Cenário actual" documents. It must be
 *   whole-pipeline, not per-step: a hand-authored pipeline can legally list an explicit
 *   step *before* the (dependsOn-omitting) root it depends on — chaining that root to its
 *   array predecessor instead of treating it as a root would fabricate a cycle out of a
 *   valid DAG.
 * - **Explicit DAG**: once any step declares `dependsOn` (including `dependsOn: []`, a
 *   genuinely independent root), the whole pipeline is in explicit mode — every other
 *   step's omitted `dependsOn` simply means "no dependency" (a root), never implicit
 *   chaining. Multiple roots and fan-out (many steps depending on the same parent) are
 *   both legal. Fan-in (`dependsOn.length > 1`) is rejected — no built-in processor
 *   accepts more than one input yet (`docs/90-deferred-register.md`).
 *
 * Returns steps in topological order (stable by original array index within a layer) with
 * `dependsOn` fully resolved (defaults applied) on every step.
 */
export function resolveDag(steps: StepDto[]): ResolvedStep[] {
  if (steps.length === 0) {
    return [];
  }

  const byId = new Map<string, StepDto>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new DagValidationError(
        'DUPLICATE_STEP_ID',
        `Duplicate step id "${step.id}"`,
      );
    }
    byId.set(step.id, step);
  }

  const implicitChainMode = steps.every((step) => step.dependsOn === undefined);

  const resolvedDependsOn = new Map<string, string[]>();
  steps.forEach((step, index) => {
    if (step.dependsOn !== undefined) {
      if (step.dependsOn.length > 1) {
        throw new DagValidationError(
          'FAN_IN_NOT_SUPPORTED',
          `Step "${step.id}" depends on multiple steps (${step.dependsOn.join(', ')}) — fan-in is not supported (no built-in processor accepts more than one input)`,
        );
      }
      for (const parentId of step.dependsOn) {
        if (!byId.has(parentId)) {
          throw new DagValidationError(
            'MISSING_DEPENDENCY',
            `Step "${step.id}" depends on unknown step "${parentId}"`,
          );
        }
      }
      resolvedDependsOn.set(step.id, [...step.dependsOn]);
      return;
    }

    if (!implicitChainMode) {
      // Explicit-DAG pipeline, this step just happens to omit dependsOn:
      // that means "no dependency" (a root), not "chain to whatever
      // happens to precede me in the array."
      resolvedDependsOn.set(step.id, []);
      return;
    }

    // Pure implicit-chain pipeline: depend on the immediately preceding
    // array entry, if any.
    const previous = index > 0 ? steps[index - 1] : undefined;
    resolvedDependsOn.set(step.id, previous ? [previous.id] : []);
  });

  // Kahn's algorithm: repeatedly remove zero-indegree nodes. Leftover nodes
  // once no more can be removed form a cycle (or are unreachable because
  // they're part of one).
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const step of steps) {
    indegree.set(step.id, resolvedDependsOn.get(step.id)!.length);
  }
  for (const step of steps) {
    for (const parentId of resolvedDependsOn.get(step.id)!) {
      children.set(parentId, [...(children.get(parentId) ?? []), step.id]);
    }
  }

  // Stable by original array order within each "layer" of zero-indegree
  // nodes, so output order stays predictable for a plain linear chain.
  const remaining = new Set(steps.map((s) => s.id));
  const ordered: ResolvedStep[] = [];
  let frontier = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const step = byId.get(id)!;
      ordered.push({
        id: step.id,
        processor: step.processor,
        params: step.params,
        dependsOn: resolvedDependsOn.get(step.id)!,
      });
      remaining.delete(id);
      for (const childId of children.get(id) ?? []) {
        const updated = (indegree.get(childId) ?? 0) - 1;
        indegree.set(childId, updated);
        if (updated === 0) {
          next.push(childId);
        }
      }
    }
    // Keep next layer in original array order too.
    frontier = steps.map((s) => s.id).filter((id) => next.includes(id));
  }

  if (remaining.size > 0) {
    throw new DagValidationError(
      'CYCLE_DETECTED',
      `Cycle detected among step(s): ${[...remaining].join(', ')}`,
    );
  }

  return ordered;
}
