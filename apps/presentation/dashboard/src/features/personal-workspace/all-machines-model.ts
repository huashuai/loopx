import type { StatusSource } from "../../data/status-source-catalog";
import type { WorkspaceGoal, WorkspaceModel } from "./personal-workspace-model";

export const MACHINE_OBSERVATION_STALE_AFTER_MS = 120_000;

export type MachineSourceRef = Readonly<{
  sourceId: string;
  sourceLabel: string;
  statusUrl: string;
}>;

export type MachineGoalRef = MachineSourceRef & Readonly<{ goalId: string }>;
export type MachineTodoRef = MachineGoalRef & Readonly<{ todoId: string }>;

export type MachineObservation = {
  source: StatusSource;
  phase: "loading" | "ready" | "error";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  model: WorkspaceModel | null;
  currentError: string | null;
};

export type MachineHealthState =
  | "loading"
  | "healthy"
  | "degraded"
  | "stale"
  | "unavailable";

export type AllMachinesMachine = {
  ref: MachineSourceRef;
  health: MachineHealthState;
  lastSuccessAt: number | null;
  activeGoalCount: number;
  openTodoCount: number;
  issues: string[];
};

export type AllMachinesGoal = {
  ref: MachineGoalRef;
  key: string;
  goal: WorkspaceGoal;
  openTodoCount: number;
  topTodo: WorkspaceModel["userTodos"][number] | null;
};

export type AllMachinesTodo = {
  ref: MachineTodoRef;
  key: string;
  todo: WorkspaceModel["userTodos"][number];
};

export type AllMachinesOverview = {
  machines: AllMachinesMachine[];
  goals: AllMachinesGoal[];
  todos: AllMachinesTodo[];
  totals: {
    machineCount: number;
    healthyMachineCount: number;
    ongoingGoalCount: number;
    openTodoCount: number;
  };
};

export function machineGoalKey(ref: MachineGoalRef): string {
  return JSON.stringify([ref.sourceId, ref.goalId]);
}

export function machineTodoKey(ref: MachineTodoRef): string {
  return JSON.stringify([ref.sourceId, ref.goalId, ref.todoId]);
}

function sourceRefFor(source: StatusSource): MachineSourceRef {
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    statusUrl: source.statusUrl,
  };
}

function machineHealth(observation: MachineObservation, now: number): MachineHealthState {
  if (observation.phase === "loading" && observation.lastSuccessAt === null) return "loading";
  if (observation.phase === "error" && observation.lastSuccessAt === null) return "unavailable";
  if (observation.lastSuccessAt === null) return "loading";
  if (observation.phase === "error"
      || now - observation.lastSuccessAt > MACHINE_OBSERVATION_STALE_AFTER_MS) {
    return "stale";
  }
  const health = observation.model?.systemHealth;
  if (health && (!health.ok || health.issues.length > 0 || health.freshnessWarning)) {
    return "degraded";
  }
  return "healthy";
}

function goalPriority(goal: WorkspaceGoal) {
  switch (goal.state) {
    case "需修复": return 0;
    case "等你": return 1;
    case "推进中": return 2;
    case "等待条件": return 3;
    case "安静运行": return 4;
    default: return 5;
  }
}

function ongoingGoals(model: WorkspaceModel | null) {
  return (model?.goals ?? [])
    .filter((goal) => goal.activationState === "active" && !["已完成", "已停止"].includes(goal.state))
    .map((goal, order) => ({ goal, order }))
    .sort((left, right) => goalPriority(left.goal) - goalPriority(right.goal)
      || (right.goal.latestActivity ?? "").localeCompare(left.goal.latestActivity ?? "")
      || left.order - right.order)
    .map(({ goal }) => goal);
}

function machineIssues(observation: MachineObservation) {
  const health = observation.model?.systemHealth;
  return [
    ...(observation.currentError ? ["Status refresh failed"] : []),
    ...(health?.issues ?? []),
    ...(health?.freshnessWarning ? [health.freshnessWarning] : []),
  ];
}

export function buildAllMachinesOverview(
  observations: ReadonlyMap<string, MachineObservation>,
  now: number,
): AllMachinesOverview {
  const machines: AllMachinesMachine[] = [];
  const goals: AllMachinesGoal[] = [];
  const todos: AllMachinesTodo[] = [];

  for (const observation of observations.values()) {
    const sourceRef = sourceRefFor(observation.source);
    const sourceGoals = ongoingGoals(observation.model);
    const sourceGoalIds = new Set(sourceGoals.map((goal) => goal.goalId));
    const sourceTodos = (observation.model?.userTodos ?? []).filter((todo) => sourceGoalIds.has(todo.goalId));

    for (const goal of sourceGoals) {
      const ref: MachineGoalRef = { ...sourceRef, goalId: goal.goalId };
      const goalTodos = sourceTodos.filter((todo) => todo.goalId === goal.goalId);
      goals.push({
        ref,
        key: machineGoalKey(ref),
        goal,
        openTodoCount: goalTodos.length,
        topTodo: goalTodos[0] ?? null,
      });
      for (const todo of goalTodos) {
        const todoRef: MachineTodoRef = { ...ref, todoId: todo.todoId };
        todos.push({ ref: todoRef, key: machineTodoKey(todoRef), todo });
      }
    }

    machines.push({
      ref: sourceRef,
      health: machineHealth(observation, now),
      lastSuccessAt: observation.lastSuccessAt,
      activeGoalCount: sourceGoals.length,
      openTodoCount: sourceTodos.length,
      issues: machineIssues(observation),
    });
  }

  return {
    machines,
    goals,
    todos,
    totals: {
      machineCount: machines.length,
      healthyMachineCount: machines.filter((machine) => machine.health === "healthy").length,
      ongoingGoalCount: goals.length,
      openTodoCount: todos.length,
    },
  };
}
