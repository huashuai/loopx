import { z } from "zod";
import { parseStatusPayload, type StatusPayload } from "./status";

const directorySchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal("loopx_workspace_directory_v1"),
  registry_revision: z.string(),
  goals: z.array(z.object({
    id: z.string(),
    display_name: z.string(),
    activation_state: z.enum(["active", "stopped"]),
    registry_member: z.literal(true),
  })),
});
export type WorkspaceDirectory = z.infer<typeof directorySchema>;
export type WorkspaceLoadError = "timeout" | "network" | "service" | "revision" | "scope" | "invalid";
export type WorkspaceProgress = {
  directory: WorkspaceDirectory;
  snapshots: Record<string, StatusPayload>;
  errors: Record<string, WorkspaceLoadError>;
};

export class WorkspaceGoalSnapshotError extends Error {
  constructor(readonly code: WorkspaceLoadError) {
    super(code);
    this.name = "WorkspaceGoalSnapshotError";
  }
}

function queryUrl(url: string, fields: Record<string, string>, base: string) {
  const parsed = new URL(url, base);
  parsed.searchParams.delete("goal_activation");
  parsed.searchParams.delete("goal_id");
  parsed.searchParams.delete("view");
  for (const [key, value] of Object.entries(fields)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

export async function fetchWorkspaceDirectory(url: string, base: string): Promise<WorkspaceDirectory | null> {
  const response = await fetch(queryUrl(url, { view: "workspace-directory" }, base), {
    cache: "no-store", signal: AbortSignal.timeout(5_000),
  });
  // Older/read-only status servers retain their original full-payload path.
  if (!response.ok) return null;
  const result = directorySchema.safeParse(await response.json());
  return result.success ? result.data : null;
}

export function directoryStatusPayload(directory: WorkspaceDirectory): StatusPayload {
  return parseStatusPayload({
    ok: true, registry: "", runtime_root: "", goal_count: directory.goals.length,
    run_count: 0, local_dashboard_api: {},
    contract: { ok: true, summary: { errors: 0, warnings: 0, checks: 0 }, errors: [], warnings: [] },
    attention_queue: { available: false, item_count: 0, needs_user_or_controller: 0,
      needs_codex: 0, watching_external_evidence: 0, items: [] },
    run_history: { available: false, goal_count: directory.goals.length, run_count: 0,
      goals: directory.goals, recent_runs: [] },
  });
}

/** Fetch one exact Goal at one verified workspace registry revision. */
export async function fetchWorkspaceGoalSnapshot(
  url: string,
  base: string,
  goalId: string,
  registryRevision: string,
  signal?: AbortSignal,
): Promise<StatusPayload> {
  let response: Response;
  try {
    response = await fetch(queryUrl(url, { goal_id: goalId }, base), {
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof WorkspaceGoalSnapshotError) throw error;
    throw new WorkspaceGoalSnapshotError(error instanceof TypeError ? "network" : "invalid");
  }
  if (!response.ok) {
    throw new WorkspaceGoalSnapshotError(
      response.status === 409 ? "revision" : response.status >= 500 ? "service" : "scope",
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new WorkspaceGoalSnapshotError("invalid");
  }
  if (!raw || typeof raw !== "object"
      || (raw as Record<string, unknown>).workspace_registry_revision !== registryRevision) {
    throw new WorkspaceGoalSnapshotError("revision");
  }
  let payload: StatusPayload;
  try {
    payload = parseStatusPayload(raw);
  } catch {
    throw new WorkspaceGoalSnapshotError("invalid");
  }
  if (payload.run_history.goals.length !== 1 || payload.run_history.goals[0]?.id !== goalId) {
    throw new WorkspaceGoalSnapshotError("scope");
  }
  return payload;
}

/** Bounded fan-out: a slow/failed Goal cannot block the directory or its peers. */
export async function loadWorkspaceGoalSnapshots(
  url: string,
  base: string,
  directory: WorkspaceDirectory,
  onGoal: (id: string, payload: StatusPayload | null, error: WorkspaceLoadError | null) => void,
  isCurrent: () => boolean,
  preferredGoal: () => string,
  signal?: AbortSignal,
) {
  const pending = [...directory.goals];
  const attempts = new Map<string, number>();
  async function worker() {
    while (pending.length && isCurrent() && !signal?.aborted) {
      const preferred = pending.findIndex((goal) => goal.id === preferredGoal());
      const index = preferred >= 0 ? preferred : pending.findIndex((goal) => goal.activation_state === "active");
      // Stopped Goal names are already visible. Read their history on selection.
      if (index < 0) return;
      const goal = pending.splice(index, 1)[0];
      const attempt = (attempts.get(goal.id) ?? 0) + 1;
      attempts.set(goal.id, attempt);
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
      let failure: WorkspaceLoadError | null = null;
      try {
        const payload = await fetchWorkspaceGoalSnapshot(
          url,
          base,
          goal.id,
          directory.registry_revision,
          controller.signal,
        );
        if (isCurrent() && !signal?.aborted) onGoal(goal.id, payload, null);
      } catch (error) {
        failure = timedOut
          ? "timeout"
          : error instanceof WorkspaceGoalSnapshotError
            ? error.code
            : "invalid";
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
      if (!isCurrent() || signal?.aborted) return;
      if (failure && ["timeout", "network", "service"].includes(failure) && attempt < 3) {
        // Peers can continue during bounded retry backoff after a restart.
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        pending.push(goal);
      } else if (failure) onGoal(goal.id, null, failure);
    }
  }
  await Promise.all([worker(), worker()]);
}
