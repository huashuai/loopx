import type { StatusSource } from "../../data/status-source-catalog";

export type CommittedMachineBinding = Readonly<{
  sourceId: string;
  statusUrl: string;
  selectionRevision: number;
  registryRevision: string | null;
  committedAt: number;
  verifiedGoalIds: ReadonlySet<string>;
}>;

export type MachineBindingToken = Pick<
  CommittedMachineBinding,
  "sourceId" | "selectionRevision" | "registryRevision"
>;

export type MachineWriteState =
  | { kind: "all_machines" }
  | { kind: "selecting" }
  | { kind: "source_mismatch" }
  | { kind: "goal_unverified"; goalId: string }
  | { kind: "source_read_only"; binding: CommittedMachineBinding }
  | { kind: "ready"; binding: CommittedMachineBinding };

export class MachineAuthorityError extends Error {
  constructor(readonly code: "machine_binding_stale") {
    super(code);
    this.name = "MachineAuthorityError";
  }
}

export function deriveMachineWriteAuthority(input: {
  view: "machine" | "all-machines";
  requestedSourceId: string | null;
  committed: CommittedMachineBinding | null;
  source: StatusSource | null;
  selectedGoalId: string | null;
}): MachineWriteState {
  if (input.view === "all-machines") return { kind: "all_machines" };
  if (!input.committed || input.requestedSourceId) return { kind: "selecting" };
  if (!input.source
      || input.source.id !== input.committed.sourceId
      || input.source.statusUrl !== input.committed.statusUrl) {
    return { kind: "source_mismatch" };
  }
  if (input.selectedGoalId && !input.committed.verifiedGoalIds.has(input.selectedGoalId)) {
    return { kind: "goal_unverified", goalId: input.selectedGoalId };
  }
  if (input.source.readOnly) {
    return { kind: "source_read_only", binding: input.committed };
  }
  return { kind: "ready", binding: input.committed };
}

export function bindingToken(binding: CommittedMachineBinding): MachineBindingToken {
  return {
    sourceId: binding.sourceId,
    selectionRevision: binding.selectionRevision,
    registryRevision: binding.registryRevision,
  };
}

export function assertMachineWriteTarget(
  current: MachineWriteState,
  expected: MachineBindingToken,
  goalId?: string,
): asserts current is Extract<MachineWriteState, { kind: "ready" }> {
  if (current.kind !== "ready"
      || current.binding.sourceId !== expected.sourceId
      || current.binding.selectionRevision !== expected.selectionRevision
      || current.binding.registryRevision !== expected.registryRevision
      || (goalId !== undefined && !current.binding.verifiedGoalIds.has(goalId))) {
    throw new MachineAuthorityError("machine_binding_stale");
  }
}
