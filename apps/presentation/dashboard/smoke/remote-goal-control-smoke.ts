import {
  assertRemoteGoalControlSource,
  connectRemoteGoalControl,
} from "../src/data/remote-goal-control.js";
import {
  applyTypedAction,
  previewTypedAction,
} from "../src/data/chat.js";
import type { StatusSource } from "../src/data/status-source-catalog.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, received ${String(actual)}`);
}

async function rejects(action: () => Promise<unknown>, pattern: RegExp, message: string) {
  try {
    await action();
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), message);
    return;
  }
  throw new Error(`${message}: request unexpectedly succeeded`);
}

const source: StatusSource = {
  id: "ssh-remote-lab",
  goalCreationRequested: true,
  kind: "ssh_tunnel",
  label: "Remote lab",
  readOnly: true,
  statusUrl: "http://127.0.0.1:8876/status.json",
};

const capabilities = {
  ok: true as const,
  schema_version: "loopx_chat_capabilities_v1" as const,
  agent_backend: "multi_adapter",
  sandbox: "read-only",
  approval_policy: "never",
  todo_write: "preview_locked",
  goal_id: null,
  runtime_identity: {
    schema_version: "loopx_runtime_identity_v1" as const,
    package_version: "0.6.0",
    release_id: "release-fixture",
    source_revision: "revision-fixture",
  },
  control_plane_instance_id: "control-plane-fixture",
  remote_goal_creation: "preview_locked_instance_bound" as const,
  typed_actions: true,
  action_kinds: ["goal.create"],
};

const connected = await connectRemoteGoalControl(source, async (target) => {
  equal(target.origin, "http://127.0.0.1:8876", "the capability handshake uses the selected tunnel origin");
  return capabilities;
});
equal(connected.sourceId, source.id, "the connection remains bound to the selected source");
equal(connected.target.controlPlaneInstanceId, "control-plane-fixture", "the connection pins the remote service instance");

await rejects(
  () => connectRemoteGoalControl({ ...source, goalCreationRequested: false }, async () => capabilities),
  /not enabled/i,
  "a persisted source without explicit owner opt-in stays read-only",
);
await rejects(
  () => connectRemoteGoalControl(source, async () => ({ ...capabilities, action_kinds: ["todo.create"] })),
  /goal\.create/i,
  "a remote service must explicitly advertise Goal creation",
);

const requests: Array<{ body: Record<string, unknown>; headers: Headers; method: string; url: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  requests.push({ body, headers, method: String(init?.method ?? "GET"), url });
  const proposal = {
    schema_version: "loopx_chat_action_proposal_v1",
    proposal_id: "proposal-remote-goal",
    action_kind: "goal.create",
    summary: "Create remote Goal",
    normalized_parameters: { goal_id: "remote-goal" },
    context: { kind: "manager" },
    expected_state_fingerprint: "sha256:fixture",
    permission_classification: "workspace_write_on_confirmation",
    validation_evidence: [],
    available_transitions: ["apply"],
    status: url.endsWith("/apply") ? "applied" : "preview_ready",
    receipt: url.endsWith("/apply") ? { projection_verified: true } : null,
    stale: null,
    created_at: "2026-09-06T00:00:00Z",
    updated_at: "2026-09-06T00:00:00Z",
  };
  return new Response(JSON.stringify({ ok: true, proposal }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
};

try {
  const request = {
    actionKind: "goal.create" as const,
    context: { kind: "manager", goal_id: null },
    idempotencyKey: "remote-goal-fixture",
    normalizedParameters: { goal_id: "remote-goal", objective: "Create it remotely" },
    summary: "Create remote Goal",
  };
  const preview = await previewTypedAction(request, connected.target);
  equal(preview.proposal_id, "proposal-remote-goal", "the remote preview is parsed through the typed action contract");
  equal(requests[0].url, "http://127.0.0.1:8876/api/actions/preview", "preview never falls back to the local Dashboard origin");
  equal(requests[0].headers.get("X-LoopX-Control-Plane-Instance"), "control-plane-fixture", "preview pins the verified remote instance");

  await applyTypedAction(preview.proposal_id, connected.target);
  equal(requests[1].url, "http://127.0.0.1:8876/api/actions/proposal-remote-goal/apply", "apply remains on the preview source");
  equal(requests[1].headers.get("X-LoopX-Control-Plane-Instance"), "control-plane-fixture", "apply pins the same remote instance");

  await rejects(
    () => previewTypedAction({ ...request, actionKind: "todo.create" }, connected.target),
    /remote.*goal\.create/i,
    "the remote target rejects every write except Goal creation",
  );
  equal(requests.length, 2, "a rejected non-Goal write never reaches either control plane");
} finally {
  globalThis.fetch = originalFetch;
}

try {
  assertRemoteGoalControlSource(connected, "ssh-another-host");
  throw new Error("source switch unexpectedly passed");
} catch (error) {
  assert(/source changed/i.test(error instanceof Error ? error.message : String(error)), "apply fails closed when the selected source changed after preview");
}

console.log("remote Goal control smoke: ok");
