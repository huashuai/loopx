import { resolveFrontstageOpsStatusUrl } from "./local-status-query";

export const defaultLocalStatusSourceUrl = "/status.json";
export const statusSourceCatalogStorageKey = "loopx-status-source-catalog-v1";

export type SshSourceBinding = {
  machineId: string;
  controlPlaneInstanceId: string;
  schemaVersion: "ssh_source_binding_v2";
};

export type StatusSource = {
  goalCreationRequested: boolean;
  id: string;
  kind: "local" | "ssh_tunnel";
  label: string;
  readOnly: boolean;
  sshHostAlias?: string | null;
  sourceBinding?: SshSourceBinding | null;
  statusUrl: string;
};

export type StatusSourceCatalog = {
  schemaVersion: 1;
  sources: StatusSource[];
};

export type StatusSourceStorage = Pick<Storage, "getItem" | "setItem">;

export type RemoteGoalCreationConnectionState = "disabled" | "checking" | "ready" | "error";

export function remoteGoalCreationControlPresentation(
  requested: boolean,
  state: RemoteGoalCreationConnectionState,
) {
  if (state === "checking") return { action: "wait", label: "checking" } as const;
  if (requested && state === "ready") return { action: "disable", label: "ready" } as const;
  if (requested && state === "error") return { action: "retry", label: "retry" } as const;
  return { action: "enable", label: "enable" } as const;
}

export const localStatusSource: StatusSource = {
  goalCreationRequested: false,
  id: "local",
  kind: "local",
  label: "本机",
  readOnly: false,
  sshHostAlias: null,
  sourceBinding: null,
  statusUrl: defaultLocalStatusSourceUrl,
};

type AddStatusSourceResult =
  | { catalog: StatusSourceCatalog; source: StatusSource }
  | { error: string };

type NormalizedTunnelUrl = { url: string } | { error: string };

function normalizedTunnelUrl(value: string, baseHref: string): NormalizedTunnelUrl {
  const trimmed = value.trim();
  const explicitValue = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)
    ? `http://${trimmed}`
    : trimmed;
  const resolved = resolveFrontstageOpsStatusUrl(explicitValue, baseHref);
  const source = resolved.source;
  if (!source || !source.isLoopback || source.isRelative) {
    return { error: "SSH 隧道来源必须使用显式的 localhost、127.0.0.1 或 ::1 URL。" };
  }
  const parsed = new URL(source.url, baseHref);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    return { error: "状态来源只支持 HTTP 或 HTTPS。" };
  }
  return { url: parsed.toString() };
}

function sourceId(statusUrl: string) {
  let hash = 2166136261;
  for (const character of statusUrl) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `ssh-${(hash >>> 0).toString(36)}`;
}

function parseSourceBinding(value: unknown): SshSourceBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const machineId = typeof candidate.machineId === "string"
    ? candidate.machineId.trim()
    : "";
  const instanceId = typeof candidate.controlPlaneInstanceId === "string"
    ? candidate.controlPlaneInstanceId.trim()
    : "";
  if (candidate.schemaVersion !== "ssh_source_binding_v2"
      || !/^[A-Za-z0-9_-]{16,160}$/.test(machineId)
      || !/^[A-Za-z0-9_-]{16,160}$/.test(instanceId)) return null;
  return {
    machineId,
    controlPlaneInstanceId: instanceId,
    schemaVersion: "ssh_source_binding_v2",
  };
}

function parseSshHostAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const alias = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(alias) ? alias : null;
}

function parseStoredSource(value: unknown, baseHref: string): StatusSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "ssh_tunnel" || typeof candidate.label !== "string" || typeof candidate.statusUrl !== "string") {
    return null;
  }
  const label = candidate.label.trim();
  const resolved = normalizedTunnelUrl(candidate.statusUrl, baseHref);
  if (!label || label.length > 48 || !("url" in resolved)) return null;
  return {
    goalCreationRequested: candidate.goalCreationRequested === true,
    id: sourceId(resolved.url),
    kind: "ssh_tunnel",
    label,
    readOnly: true,
    sshHostAlias: parseSshHostAlias(candidate.sshHostAlias),
    sourceBinding: parseSourceBinding(candidate.sourceBinding),
    statusUrl: resolved.url,
  };
}

export function emptyStatusSourceCatalog(): StatusSourceCatalog {
  return { schemaVersion: 1, sources: [localStatusSource] };
}

export function loadStatusSourceCatalog(storage: StatusSourceStorage, baseHref: string): StatusSourceCatalog {
  try {
    const raw = storage.getItem(statusSourceCatalogStorageKey);
    if (!raw) return emptyStatusSourceCatalog();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) return emptyStatusSourceCatalog();
    const seenUrls = new Set([localStatusSource.statusUrl]);
    const sources = parsed.sources.flatMap((value) => {
      const source = parseStoredSource(value, baseHref);
      if (!source || seenUrls.has(source.statusUrl)) return [];
      seenUrls.add(source.statusUrl);
      return [source];
    });
    return { schemaVersion: 1, sources: [localStatusSource, ...sources] };
  } catch {
    return emptyStatusSourceCatalog();
  }
}

export function saveStatusSourceCatalog(storage: StatusSourceStorage, catalog: StatusSourceCatalog) {
  storage.setItem(statusSourceCatalogStorageKey, JSON.stringify({
    schemaVersion: 1,
    sources: catalog.sources.filter((source) => source.kind === "ssh_tunnel"),
  }));
}

export function addSshTunnelStatusSource(
  catalog: StatusSourceCatalog,
  input: { label: string; sshHostAlias?: string | null; statusUrl: string },
  baseHref: string,
): AddStatusSourceResult {
  const label = input.label.trim();
  if (!label) return { error: "请填写来源名称。" };
  if (label.length > 48) return { error: "来源名称不能超过 48 个字符。" };
  const resolved = normalizedTunnelUrl(input.statusUrl, baseHref);
  if (!("url" in resolved)) return resolved;
  if (catalog.sources.some((source) => source.statusUrl === resolved.url)) {
    return { error: "这个状态 URL 已经在来源目录中。" };
  }
  const source: StatusSource = {
    goalCreationRequested: false,
    id: sourceId(resolved.url),
    kind: "ssh_tunnel",
    label,
    readOnly: true,
    sshHostAlias: parseSshHostAlias(input.sshHostAlias),
    sourceBinding: null,
    statusUrl: resolved.url,
  };
  return {
    catalog: { ...catalog, sources: [...catalog.sources, source] },
    source,
  };
}

export function bindSshTunnelStatusSource(
  catalog: StatusSourceCatalog,
  sourceIdToUpdate: string,
  binding: SshSourceBinding,
): StatusSourceCatalog {
  const normalized = parseSourceBinding(binding);
  if (!normalized) return catalog;
  return {
    ...catalog,
    sources: catalog.sources.map((source) => source.kind === "ssh_tunnel" && source.id === sourceIdToUpdate
      ? { ...source, sourceBinding: normalized }
      : source),
  };
}

export function removeStatusSource(catalog: StatusSourceCatalog, sourceIdToRemove: string): StatusSourceCatalog {
  return {
    ...catalog,
    sources: catalog.sources.filter((source) => source.kind === "local" || source.id !== sourceIdToRemove),
  };
}

export function setRemoteGoalCreationRequested(
  catalog: StatusSourceCatalog,
  sourceIdToUpdate: string,
  requested: boolean,
): StatusSourceCatalog {
  return {
    ...catalog,
    sources: catalog.sources.map((source) => source.kind === "ssh_tunnel" && source.id === sourceIdToUpdate
      ? { ...source, goalCreationRequested: requested }
      : source),
  };
}

export function statusSourceForUrl(catalog: StatusSourceCatalog, statusUrl: string, baseHref: string) {
  if (!statusUrl.trim()) return localStatusSource;
  const resolved = resolveFrontstageOpsStatusUrl(statusUrl, baseHref);
  if (resolved.source?.isRelative) return localStatusSource;
  let normalized = statusUrl.trim();
  try {
    normalized = new URL(normalized, baseHref).toString();
  } catch {
    return null;
  }
  return catalog.sources.find((source) => source.statusUrl === normalized) ?? null;
}

export function projectedStatusSourceForUrl(catalog: StatusSourceCatalog, statusUrl: string, baseHref: string): StatusSource {
  const registered = statusSourceForUrl(catalog, statusUrl, baseHref);
  if (registered) return registered;
  const resolved = resolveFrontstageOpsStatusUrl(statusUrl, baseHref);
  if (resolved.source?.isRelative) return localStatusSource;
  return {
    goalCreationRequested: false,
    id: "temporary",
    kind: "ssh_tunnel",
    label: "临时来源",
    readOnly: true,
    sshHostAlias: null,
    sourceBinding: null,
    statusUrl: statusUrl.trim(),
  };
}

export function activeStatusSourceForUrl(
  catalog: StatusSourceCatalog,
  requestedStatusUrl: string | null,
  loadedStatusUrl: string,
  baseHref: string,
): StatusSource {
  // The active source follows the user's in-flight selection so a slow or
  // failed switch does not make the switcher appear to bounce back to the
  // previously loaded source.
  return projectedStatusSourceForUrl(catalog, requestedStatusUrl ?? loadedStatusUrl, baseHref);
}
