import {
  goalTitleFromMessage,
  proposalFields,
} from "../src/features/personal-workspace/proposal-presentation.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
}

const copy: Record<string, string> = {
  "proposal.field.agentId": "Agent",
  "proposal.field.completionCriteria": "Completion criteria",
  "proposal.field.goalId": "Goal ID",
  "proposal.field.heartbeat": "Heartbeat",
  "proposal.field.initialTodos": "Initial task",
  "proposal.field.operation": "Operation",
  "proposal.field.permission": "Access",
  "proposal.field.stopCondition": "Stops",
  "proposal.field.workspace": "Workspace",
  "proposal.value.heartbeat.off": "Off",
  "proposal.value.permission.confirmedWrite": "Write after confirmation",
  "proposal.value.stop.goalComplete": "When Goal is complete",
  "proposal.workspace.current": "Current configured workspace",
  "proposal.workspace.source": "{source} · configured workspace",
};

function translate(key: string, parameters?: Record<string, string | number>) {
  let value = copy[key] ?? key;
  for (const [name, replacement] of Object.entries(parameters ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

const issueMessage = [
  "Create a Goal:",
  "Objective: https://jira.example.test/browse/PROJECT-123",
  "Completion criteria: create PR",
].join("\n");
equal(goalTitleFromMessage(issueMessage, "New Goal"), "PROJECT-123", "issue URL title");

const fields = proposalFields({
  agent_id: "codex",
  completion_criteria: "create PR",
  execution_boundary: "",
  goal_id: "project-123",
  heartbeat: { cadence: "1d", enabled: false, timezone: "Asia/Shanghai" },
  initial_todos: ["Work toward the completion criteria: create PR"],
  objective: "https://jira.example.test/browse/PROJECT-123\nCompletion criteria: create PR",
  permission: "workspace_write_on_confirmation",
  stop_condition: "goal_complete",
  title: "PROJECT-123",
  workspace_ref: "current",
}, translate, {
  actionKind: "goal.create",
  currentWorkspaceLabel: "Remote A",
});

equal(
  fields.map((field) => field.key).join(","),
  "completion_criteria,permission,agent_id,workspace_ref,initial_todos,heartbeat,stop_condition",
  "Goal confirmation field order",
);
equal(fields.find((field) => field.key === "permission")?.value, "Write after confirmation", "permission copy");
equal(fields.find((field) => field.key === "agent_id")?.value, "Codex", "Agent copy");
equal(fields.find((field) => field.key === "workspace_ref")?.value, "Remote A · configured workspace", "workspace copy");
equal(fields.find((field) => field.key === "heartbeat")?.value, "Off", "heartbeat copy");
equal(fields.find((field) => field.key === "stop_condition")?.value, "When Goal is complete", "stop copy");
const visibleValues = fields.map((field) => field.value).join("\n");
for (const rawValue of ["jira.example.test", "workspace_write_on_confirmation", "{\"enabled\"", "goal_complete", "project-123"]) {
  assert(!visibleValues.includes(rawValue), `Goal confirmation leaked raw value: ${rawValue}`);
}

const lifecycleFields = proposalFields({ goal_id: "goal-one", operation: "stop" }, translate, {
  actionKind: "goal.lifecycle",
});
equal(lifecycleFields.map((field) => field.key).join(","), "goal_id,operation", "non-create field parity");

console.log("proposal-presentation smoke ok");
