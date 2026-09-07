type ProposalMessageKey =
  | "proposal.field.agentId"
  | "proposal.field.cadence"
  | "proposal.field.completionCriteria"
  | "proposal.field.executionBoundary"
  | "proposal.field.goalId"
  | "proposal.field.heartbeat"
  | "proposal.field.initialTodos"
  | "proposal.field.objective"
  | "proposal.field.operation"
  | "proposal.field.permission"
  | "proposal.field.reason"
  | "proposal.field.stopCondition"
  | "proposal.field.target"
  | "proposal.field.timezone"
  | "proposal.field.title"
  | "proposal.field.workspace"
  | "proposal.value.heartbeat.off"
  | "proposal.value.heartbeat.on"
  | "proposal.value.permission.confirmedWrite"
  | "proposal.value.permission.readOnly"
  | "proposal.value.stop.goalComplete"
  | "proposal.value.stop.prMerged"
  | "proposal.workspace.current"
  | "proposal.workspace.named"
  | "proposal.workspace.source";

type ProposalTranslate = (
  key: ProposalMessageKey,
  values?: Record<string, string | number>,
) => string;

type ProposalPresentationOptions = {
  actionKind: string;
  currentWorkspaceLabel?: string;
};

const fieldPriority = [
  "title",
  "objective",
  "completion_criteria",
  "execution_boundary",
  "permission",
  "agent_id",
  "workspace_ref",
  "initial_todos",
  "heartbeat",
  "stop_condition",
  "goal_id",
];

const goalCreateFieldPriority = [
  "completion_criteria",
  "execution_boundary",
  "permission",
  "agent_id",
  "workspace_ref",
  "initial_todos",
  "heartbeat",
  "stop_condition",
];

function fieldLabel(key: string, t: ProposalTranslate) {
  const labels: Record<string, string> = {
    agent_id: t("proposal.field.agentId"),
    cadence: t("proposal.field.cadence"),
    completion_criteria: t("proposal.field.completionCriteria"),
    execution_boundary: t("proposal.field.executionBoundary"),
    goal_id: t("proposal.field.goalId"),
    heartbeat: t("proposal.field.heartbeat"),
    initial_todos: t("proposal.field.initialTodos"),
    objective: t("proposal.field.objective"),
    operation: t("proposal.field.operation"),
    permission: t("proposal.field.permission"),
    reason: t("proposal.field.reason"),
    stop_condition: t("proposal.field.stopCondition"),
    target: t("proposal.field.target"),
    timezone: t("proposal.field.timezone"),
    title: t("proposal.field.title"),
    workspace_ref: t("proposal.field.workspace"),
  };
  return labels[key] ?? key.replaceAll("_", " ");
}

function agentLabel(value: unknown) {
  const agentId = String(value ?? "—");
  return {
    "anthropic-api": "Claude API",
    "claude-code": "Claude Code",
    codex: "Codex",
    "openai-api": "OpenAI API",
  }[agentId] ?? agentId;
}

function heartbeatLabel(value: unknown, t: ProposalTranslate) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return String(value ?? "—");
  const heartbeat = value as Record<string, unknown>;
  if (heartbeat.enabled !== true) return t("proposal.value.heartbeat.off");
  return t("proposal.value.heartbeat.on", {
    cadence: String(heartbeat.cadence ?? "—"),
    timezone: String(heartbeat.timezone ?? "—"),
  });
}

function fieldValue(
  key: string,
  value: unknown,
  t: ProposalTranslate,
  options: ProposalPresentationOptions,
) {
  const goalCreate = options.actionKind === "goal.create";
  if (goalCreate && key === "agent_id") return agentLabel(value);
  if (goalCreate && key === "heartbeat") return heartbeatLabel(value, t);
  if (goalCreate && key === "permission") {
    if (value === "workspace_write_on_confirmation") return t("proposal.value.permission.confirmedWrite");
    if (value === "read_only") return t("proposal.value.permission.readOnly");
  }
  if (goalCreate && key === "stop_condition") {
    if (value === "goal_complete") return t("proposal.value.stop.goalComplete");
    if (value === "pr_merged") return t("proposal.value.stop.prMerged");
  }
  if (key === "workspace_ref") {
    if (goalCreate && value === "current" && options.currentWorkspaceLabel) {
      return t("proposal.workspace.source", { source: options.currentWorkspaceLabel });
    }
    return value === "current"
      ? t("proposal.workspace.current")
      : t("proposal.workspace.named", { workspace: String(value ?? "current") });
  }
  if (Array.isArray(value)) return value.join(" · ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value ?? "—");
}

function hasDisplayValue(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

export function proposalFields(
  parameters: Record<string, unknown>,
  t: ProposalTranslate,
  options: ProposalPresentationOptions,
) {
  const priority = options.actionKind === "goal.create" ? goalCreateFieldPriority : fieldPriority;
  const allowed = options.actionKind === "goal.create" ? new Set(goalCreateFieldPriority) : null;
  return Object.entries(parameters)
    .filter(([key, value]) => !allowed || allowed.has(key) && hasDisplayValue(value))
    .sort(([left], [right]) => {
      const leftIndex = priority.indexOf(left);
      const rightIndex = priority.indexOf(right);
      return (leftIndex < 0 ? priority.length : leftIndex) - (rightIndex < 0 ? priority.length : rightIndex);
    })
    .slice(0, 10)
    .map(([key, value]) => ({
      key,
      label: fieldLabel(key, t),
      value: fieldValue(key, value, t, options),
    }));
}

export function goalTitleFromMessage(message: string, fallbackTitle: string) {
  const issueKey = message.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)/u)?.[1];
  if (issueKey) return issueKey.toUpperCase();
  const quoted = message.match(/[「“"]([^」”"]{2,80})[」”"]/u)?.[1];
  if (quoted) return quoted.trim();
  return message
    .replace(/^(请|帮我|我想|给我|创建|新建|设置|please|i want to|create|set up)+/iu, "")
    .replace(/(一个|新的)?\s*(goal|目标)/giu, "")
    .replace(/[，。！？].*$/u, "")
    .split(/\r?\n/u)[0]
    .trim()
    .slice(0, 80) || fallbackTitle;
}
