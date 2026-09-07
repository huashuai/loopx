import {
  fetchChatCapabilities,
  type ChatApiTarget,
} from "./chat.js";
import type { StatusSource } from "./status-source-catalog.js";

type RemoteCapabilities = Awaited<ReturnType<typeof fetchChatCapabilities>>;

export type ConnectedRemoteGoalControl = {
  capabilities: RemoteCapabilities;
  sourceId: string;
  target: ChatApiTarget;
};

type CapabilityLoader = (target: ChatApiTarget) => Promise<RemoteCapabilities>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export async function connectRemoteGoalControl(
  source: StatusSource,
  loadCapabilities: CapabilityLoader = fetchChatCapabilities,
): Promise<ConnectedRemoteGoalControl> {
  if (source.kind !== "ssh_tunnel" || !source.goalCreationRequested) {
    throw new Error("Remote Goal creation is not enabled for this source.");
  }
  const statusUrl = new URL(source.statusUrl);
  if (!loopbackHosts.has(statusUrl.hostname)) {
    throw new Error("Remote Goal creation requires an explicit loopback SSH tunnel.");
  }
  const origin = statusUrl.origin;
  const capabilities = await loadCapabilities({ origin });
  if (
    capabilities.schema_version !== "loopx_chat_capabilities_v1"
    || capabilities.remote_goal_creation !== "preview_locked_instance_bound"
    || !capabilities.control_plane_instance_id
    || capabilities.typed_actions !== true
    || !capabilities.action_kinds?.includes("goal.create")
  ) {
    throw new Error("The selected remote control plane does not advertise instance-bound goal.create support.");
  }
  if (!source.sourceBinding
      || source.sourceBinding.controlPlaneInstanceId !== capabilities.control_plane_instance_id) {
    throw new Error("The selected remote source binding changed; reconnect before creating a Goal.");
  }
  return {
    capabilities,
    sourceId: source.id,
    target: {
      allowedActionKinds: ["goal.create"],
      controlPlaneInstanceId: capabilities.control_plane_instance_id,
      origin,
    },
  };
}

export function assertRemoteGoalControlSource(
  connection: ConnectedRemoteGoalControl,
  activeSourceId: string,
) {
  if (connection.sourceId !== activeSourceId) {
    throw new Error("The selected remote source changed after preview; reconnect before applying.");
  }
}
