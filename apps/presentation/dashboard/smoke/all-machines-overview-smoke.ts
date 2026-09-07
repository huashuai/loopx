import assert from "node:assert/strict";
import statusExample from "../../../../examples/status.example.json";

import {
  MACHINE_OBSERVATION_STALE_AFTER_MS,
  buildAllMachinesOverview,
  machineGoalKey,
  machineTodoKey,
  type MachineObservation,
} from "../src/features/personal-workspace/all-machines-model";
import {
  assertMachineWriteTarget,
  deriveMachineWriteAuthority,
  type CommittedMachineBinding,
} from "../src/features/personal-workspace/machine-workspace-authority";
import {
  applyMachineObservationUpdate,
  loadAllMachineSnapshots,
} from "../src/features/personal-workspace/use-all-machines-overview";
import type {
  WorkspaceGoal,
  WorkspaceModel,
  WorkspaceSystemHealth,
} from "../src/features/personal-workspace/personal-workspace-model";
import type { StatusSource } from "../src/data/status-source-catalog";
import {
  fetchMachineStatusPayload,
  MachineStatusLoadError,
} from "../src/data/local-status-query";
import {
  fetchWorkspaceGoalSnapshot,
  WorkspaceGoalSnapshotError,
} from "../src/data/workspace-progressive-status";

const now = Date.parse("2026-09-06T20:00:00Z");

function source(id: string, label: string, readOnly: boolean): StatusSource {
  return {
    goalCreationRequested: false,
    id,
    kind: readOnly ? "ssh_tunnel" : "local",
    label,
    readOnly,
    sourceBinding: readOnly ? {
      machineId: `${id}-machine`,
      controlPlaneInstanceId: `${id}-instance`,
      schemaVersion: "ssh_source_binding_v2",
    } : null,
    statusUrl: readOnly ? `http://127.0.0.1:${id === "remote-a" ? "8876" : "8976"}/status.json` : "/status.json",
  };
}

function goal(goalId: string, state: WorkspaceGoal["state"] = "推进中"): WorkspaceGoal {
  return {
    activationState: state === "已停止" ? "stopped" : "active",
    agentId: "codex",
    agentSentence: "Agent is working",
    agentTodos: [],
    goalId,
    nextSentence: "Continue the current task",
    state,
    title: "Identical visible Goal",
  };
}

function model(
  goalId: string,
  options: {
    health?: WorkspaceSystemHealth;
    state?: WorkspaceGoal["state"];
  } = {},
): WorkspaceModel {
  return {
    blockingTodoCount: 1,
    goals: [goal(goalId, options.state)],
    openUserTodoCount: 1,
    systemHealth: options.health ?? { freshnessWarning: null, issues: [], ok: true, summary: "healthy" },
    userTodos: [{
      blocking: true,
      goalId,
      goalTitle: "Identical visible Goal",
      text: "Review the same visible Todo",
      todoId: "todo-1",
    }],
  };
}

function observation(
  statusSource: StatusSource,
  workspaceModel: WorkspaceModel | null,
  options: Partial<MachineObservation> = {},
): MachineObservation {
  return {
    currentError: null,
    lastAttemptAt: now,
    lastSuccessAt: workspaceModel ? now : null,
    model: workspaceModel,
    phase: workspaceModel ? "ready" : "loading",
    source: statusSource,
    ...options,
  };
}

const local = source("local", "This machine", false);
const remoteA = source("remote-a", "Remote A", true);
const remoteB = source("remote-b", "Remote B", true);

const duplicateOverview = buildAllMachinesOverview(new Map([
  [local.id, observation(local, model("goal-1"))],
  [remoteA.id, observation(remoteA, model("goal-1"))],
] as const), now);

assert.equal(duplicateOverview.goals.length, 2, "matching Goal ids on separate sources remain separate");
assert.equal(duplicateOverview.todos.length, 2, "matching Todo ids on separate sources remain separate");
assert.equal(duplicateOverview.totals.ongoingGoalCount, 2);
assert.equal(duplicateOverview.totals.openTodoCount, 2);
assert.notEqual(duplicateOverview.goals[0].key, duplicateOverview.goals[1].key);
assert.notEqual(duplicateOverview.todos[0].key, duplicateOverview.todos[1].key);
assert.equal(
  machineGoalKey(duplicateOverview.goals[0].ref),
  JSON.stringify([duplicateOverview.goals[0].ref.sourceId, "goal-1"]),
);
assert.equal(
  machineTodoKey(duplicateOverview.todos[1].ref),
  JSON.stringify([duplicateOverview.todos[1].ref.sourceId, "goal-1", "todo-1"]),
);

const healthOverview = buildAllMachinesOverview(new Map([
  [local.id, observation(local, model("healthy"))],
  [remoteA.id, observation(remoteA, model("degraded", {
    health: { freshnessWarning: null, issues: ["contract failed"], ok: false, summary: "degraded" },
  }))],
  [remoteB.id, observation(remoteB, model("retained"), {
    currentError: "unreachable",
    lastSuccessAt: now - 1_000,
    phase: "error",
  })],
] as const), now);

assert.deepEqual(healthOverview.machines.map((machine) => machine.health), ["healthy", "degraded", "stale"]);

const staleByAge = buildAllMachinesOverview(new Map([
  [remoteA.id, observation(remoteA, model("old"), {
    lastSuccessAt: now - MACHINE_OBSERVATION_STALE_AFTER_MS - 1,
  })],
] as const), now);
assert.equal(staleByAge.machines[0].health, "stale");

const unavailable = buildAllMachinesOverview(new Map([
  [remoteA.id, observation(remoteA, null, {
    currentError: "unreachable",
    phase: "error",
  })],
] as const), now);
assert.equal(unavailable.machines[0].health, "unavailable");

const loading = buildAllMachinesOverview(new Map([
  [remoteA.id, observation(remoteA, null)],
] as const), now);
assert.equal(loading.machines[0].health, "loading");

async function sourceBindingContract() {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/api/chat/capabilities")) {
        return new Response(JSON.stringify({
          machine_id: "wrong-machine-id",
          control_plane_instance_id: remoteA.sourceBinding?.controlPlaneInstanceId,
          ok: true,
          schema_version: "loopx_chat_capabilities_v1",
        }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      return new Response(JSON.stringify(statusExample), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };
    await assert.rejects(
      fetchMachineStatusPayload(remoteA, "http://127.0.0.1:5173/", new AbortController().signal),
      (error) => error instanceof MachineStatusLoadError && error.code === "binding_mismatch",
      "a source label cannot consume status from another stable machine",
    );
    assert.deepEqual(
      requestedUrls,
      ["http://127.0.0.1:8876/api/chat/capabilities"],
      "binding mismatch fails before remote status is rendered",
    );

    requestedUrls.length = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/api/chat/capabilities")) {
        return new Response(JSON.stringify({
          machine_id: remoteA.sourceBinding?.machineId,
          control_plane_instance_id: "remote-a-restarted-instance",
          ok: true,
          schema_version: "loopx_chat_capabilities_v1",
        }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      return new Response(JSON.stringify(statusExample), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };
    const payload = await fetchMachineStatusPayload(
      remoteA,
      "http://127.0.0.1:5173/",
      new AbortController().signal,
    );
    assert.equal(payload.ok, true);
    assert.equal(
      requestedUrls.length,
      2,
      "a stable machine binding admits one status read after the control-plane process restarts",
    );

    const unbound = { ...remoteA, sourceBinding: null };
    requestedUrls.length = 0;
    await assert.rejects(
      fetchMachineStatusPayload(unbound, "http://127.0.0.1:5173/", new AbortController().signal),
      (error) => error instanceof MachineStatusLoadError && error.code === "binding_required",
      "legacy unbound sources fail closed until the owner revalidates them",
    );
    assert.equal(requestedUrls.length, 0, "an unbound source performs no remote request");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const terminal = buildAllMachinesOverview(new Map([
  [local.id, observation(local, {
    ...model("unused"),
    goals: [goal("complete", "已完成"), goal("stopped", "已停止")],
    userTodos: [],
  })],
] as const), now);
assert.equal(terminal.goals.length, 0, "completed and stopped Goals stay out of ongoing work");

const binding: CommittedMachineBinding = {
  committedAt: now,
  registryRevision: "revision-1",
  selectionRevision: 4,
  sourceId: local.id,
  statusUrl: local.statusUrl,
  verifiedGoalIds: new Set(["goal-1"]),
};

assert.equal(deriveMachineWriteAuthority({
  committed: binding,
  requestedSourceId: null,
  selectedGoalId: "goal-1",
  source: local,
  view: "all-machines",
}).kind, "all_machines");

assert.equal(deriveMachineWriteAuthority({
  committed: binding,
  requestedSourceId: remoteA.id,
  selectedGoalId: "goal-1",
  source: local,
  view: "machine",
}).kind, "selecting");

assert.equal(deriveMachineWriteAuthority({
  committed: binding,
  requestedSourceId: null,
  selectedGoalId: "missing",
  source: local,
  view: "machine",
}).kind, "goal_unverified");

const remoteBinding = { ...binding, sourceId: remoteA.id, statusUrl: remoteA.statusUrl };
assert.equal(deriveMachineWriteAuthority({
  committed: remoteBinding,
  requestedSourceId: null,
  selectedGoalId: "goal-1",
  source: remoteA,
  view: "machine",
}).kind, "source_read_only");

const ready = deriveMachineWriteAuthority({
  committed: binding,
  requestedSourceId: null,
  selectedGoalId: "goal-1",
  source: local,
  view: "machine",
});
assert.equal(ready.kind, "ready");
assert.doesNotThrow(() => assertMachineWriteTarget(ready, binding, "goal-1"));
assert.throws(
  () => assertMachineWriteTarget(ready, remoteBinding, "goal-1"),
  /machine_binding_stale/,
  "a same-named Goal on another source cannot reuse local authority",
);

async function loaderContract() {
  const sources = [local, remoteA, remoteB];
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const updates: Array<{ sourceId: string; phase: string; generation: number }> = [];
  let active = 0;
  let maxActive = 0;
  const controller = new AbortController();

  const loading = loadAllMachineSnapshots({
    buildModel: (value) => value as WorkspaceModel,
    fetchSnapshot: async (statusSource) => {
      started.push(statusSource.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(statusSource.id, resolve));
      active -= 1;
      return model(statusSource.id);
    },
    generation: 7,
    now: () => now,
    onObservation: (sourceId, update) => updates.push({
      sourceId,
      phase: update.phase,
      generation: update.generation,
    }),
    signal: controller.signal,
    sources,
  });

  await Promise.resolve();
  assert.deepEqual(started, ["local", "remote-a"], "only two source requests start concurrently");
  releases.get("local")?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["local", "remote-a", "remote-b"], "the third source starts when one worker is free");
  releases.get("remote-a")?.();
  releases.get("remote-b")?.();
  await loading;
  assert.equal(maxActive, 2);
  assert.equal(updates.filter((update) => update.phase === "ready").length, 3);

  const retained = new Map<string, MachineObservation>([
    [remoteA.id, observation(remoteA, model("retained"), { lastSuccessAt: now - 1_000 })],
  ]);
  const ignored = applyMachineObservationUpdate(retained, remoteA.id, {
    currentError: null,
    generation: 6,
    lastAttemptAt: now,
    lastSuccessAt: now,
    model: model("old-generation"),
    phase: "ready",
    source: remoteA,
  }, 7);
  assert.equal(ignored, retained, "an older load generation cannot commit");

  const failed = applyMachineObservationUpdate(retained, remoteA.id, {
    currentError: "unreachable",
    generation: 7,
    lastAttemptAt: now,
    phase: "error",
    source: remoteA,
  }, 7);
  assert.equal(failed.get(remoteA.id)?.model?.goals[0].goalId, "retained");
  assert.equal(failed.get(remoteA.id)?.lastSuccessAt, now - 1_000);
  assert.equal(failed.get(remoteA.id)?.phase, "error");

  const invalidatedBinding = applyMachineObservationUpdate(retained, remoteA.id, {
    currentError: "binding_mismatch",
    generation: 7,
    lastAttemptAt: now,
    model: null,
    phase: "error",
    source: remoteA,
  }, 7);
  assert.equal(
    invalidatedBinding.get(remoteA.id)?.model,
    null,
    "an identity mismatch clears the prior machine projection instead of showing it under an invalid binding",
  );
}

Promise.all([loaderContract(), sourceBindingContract()]).then(() => {
  const snapshot = statusPayloadForGoal("goal-1", "revision-1");
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify(snapshot), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
  return fetchWorkspaceGoalSnapshot(
    "/status.json",
    "http://127.0.0.1:5173/",
    "goal-1",
    "revision-1",
  ).then((result) => {
    assert.equal(result.run_history.goals[0]?.id, "goal-1");
    const requested = new URL(requests[0]);
    assert.equal(requested.searchParams.get("goal_id"), "goal-1");
    assert.equal(requested.searchParams.has("view"), false);
  }).then(async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ...snapshot,
      workspace_registry_revision: "revision-2",
    }), { status: 200 });
    await assert.rejects(
      fetchWorkspaceGoalSnapshot("/status.json", "http://127.0.0.1:5173/", "goal-1", "revision-1"),
      (error) => error instanceof WorkspaceGoalSnapshotError && error.code === "revision",
    );
    globalThis.fetch = async () => new Response(JSON.stringify({
      ...snapshot,
      run_history: { ...snapshot.run_history, goals: [
        ...snapshot.run_history.goals,
        { ...snapshot.run_history.goals[0], id: "goal-2" },
      ] },
    }), { status: 200 });
    await assert.rejects(
      fetchWorkspaceGoalSnapshot("/status.json", "http://127.0.0.1:5173/", "goal-1", "revision-1"),
      (error) => error instanceof WorkspaceGoalSnapshotError && error.code === "scope",
    );
  }).finally(() => {
    globalThis.fetch = originalFetch;
  });
}).then(() => {
  console.log("all machines overview smoke: ok");
});

function statusPayloadForGoal(goalId: string, registryRevision: string) {
  return {
    contract: { checks: [], errors: [], ok: true, summary: { checks: 0, errors: 0, warnings: 0 }, warnings: [] },
    goal_count: 1,
    local_dashboard_api: {},
    ok: true,
    registry: "",
    run_count: 0,
    runtime_root: "",
    workspace_registry_revision: registryRevision,
    attention_queue: {
      available: true,
      item_count: 0,
      items: [],
      needs_codex: 0,
      needs_user_or_controller: 0,
      watching_external_evidence: 0,
    },
    run_history: {
      available: true,
      goal_count: 1,
      goals: [{ activation_state: "active", display_name: goalId, id: goalId, registry_member: true }],
      recent_runs: [],
      run_count: 0,
    },
  };
}
