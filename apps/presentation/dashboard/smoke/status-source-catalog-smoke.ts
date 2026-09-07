import {
  activeStatusSourceForUrl,
  addSshTunnelStatusSource,
  bindSshTunnelStatusSource,
  defaultLocalStatusSourceUrl,
  emptyStatusSourceCatalog,
  loadStatusSourceCatalog,
  localStatusSource,
  projectedStatusSourceForUrl,
  removeStatusSource,
  remoteGoalCreationControlPresentation,
  saveStatusSourceCatalog,
  setRemoteGoalCreationRequested,
  statusSourceCatalogStorageKey,
  statusSourceForUrl,
} from "../src/data/status-source-catalog";
import {
  configuredSshTunnelDraft,
  defaultConfiguredSshHostsUrl,
  parseConfiguredSshHostCatalog,
} from "../src/data/ssh-host-catalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, received ${String(actual)}`);
}

function deepEqual(actual: unknown, expected: unknown, message: string) {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const baseHref = "http://127.0.0.1:5173/";
const initial = emptyStatusSourceCatalog();
deepEqual(initial.sources, [localStatusSource], "the default catalog contains only the local source");
equal(defaultLocalStatusSourceUrl, "/status.json", "the built-in source stays on the Dashboard origin");
equal(initial.sources[0].readOnly, false, "the built-in local control plane stays interactive");
equal(statusSourceForUrl(initial, "/status.json", baseHref)?.id, "local", "the Vite-proxied default resolves to the local source");
equal(projectedStatusSourceForUrl(initial, "/api/status.json", baseHref).readOnly, false, "a same-origin relative proxy stays local");
equal(projectedStatusSourceForUrl(initial, "http://127.0.0.1:9999/status.json", baseHref).readOnly, true, "an unregistered loopback port does not inherit local authority");

const added = addSshTunnelStatusSource(initial, {
  label: "Remote lab",
  statusUrl: "http://localhost:8876/status.json",
}, baseHref);
assert("catalog" in added, "a valid tunnel source is accepted");
equal(added.source.kind, "ssh_tunnel", "the source keeps its typed provider kind");
equal(added.source.readOnly, true, "a tunneled source cannot inherit local write authority");
equal(added.source.goalCreationRequested, false, "remote Goal creation requires a separate owner opt-in");
equal(added.source.sourceBinding, null, "a new tunnel cannot render remote state before instance verification");
equal(added.source.statusUrl, "http://localhost:8876/status.json", "the tunnel URL is canonicalized");
equal(statusSourceForUrl(added.catalog, added.source.statusUrl, baseHref)?.id, added.source.id, "URL lookup preserves source identity");

const bareLoopback = addSshTunnelStatusSource(initial, {
  label: "Bare loopback",
  statusUrl: "127.0.0.1:8879/status.json",
}, baseHref);
assert("catalog" in bareLoopback, "a pasted bare loopback address is normalized instead of becoming a Dashboard-relative path");
equal(bareLoopback.source.statusUrl, "http://127.0.0.1:8879/status.json", "bare loopback input receives an explicit HTTP scheme");

const publicSource = addSshTunnelStatusSource(initial, {
  label: "Unsafe public endpoint",
  statusUrl: "https://example.com/status.json",
}, baseHref);
assert("error" in publicSource, "public endpoints fail closed instead of entering the local control plane catalog");

const duplicate = addSshTunnelStatusSource(added.catalog, {
  label: "Duplicate",
  statusUrl: added.source.statusUrl,
}, baseHref);
assert("error" in duplicate, "one tunnel URL has one stable source identity");

const secondTunnel = addSshTunnelStatusSource(added.catalog, {
  label: "Remote build host",
  statusUrl: "http://127.0.0.1:8976/status.json",
}, baseHref);
assert("catalog" in secondTunnel, "a catalog accepts more than one named SSH tunnel");
equal(secondTunnel.catalog.sources.length, 3, "local and multiple SSH sources coexist");
assert(secondTunnel.source.id !== added.source.id, "each tunnel keeps an independent stable identity");

const storage = new MemoryStorage();
const boundCatalog = bindSshTunnelStatusSource(secondTunnel.catalog, added.source.id, {
  controlPlaneInstanceId: "remote-lab-instance",
  schemaVersion: "ssh_source_binding_v1",
});
equal(boundCatalog.sources[1].sourceBinding?.controlPlaneInstanceId, "remote-lab-instance", "a verified instance is bound to exactly one catalog source");
equal(boundCatalog.sources[2].sourceBinding, null, "binding one source never grants trust to another source");
const requestedGoalCreation = setRemoteGoalCreationRequested(boundCatalog, added.source.id, true);
equal(requestedGoalCreation.sources[1].goalCreationRequested, true, "the owner can opt one named source into remote Goal creation");
equal(requestedGoalCreation.sources[2].goalCreationRequested, false, "the opt-in never grants another source write intent");
saveStatusSourceCatalog(storage, requestedGoalCreation);
const stored = JSON.parse(storage.getItem(statusSourceCatalogStorageKey) ?? "{}");
stored.sources[0].readOnly = false;
storage.setItem(statusSourceCatalogStorageKey, JSON.stringify(stored));
const restored = loadStatusSourceCatalog(storage, baseHref);
equal(restored.sources[1].readOnly, true, "persisted input cannot downgrade a tunnel to writable");
equal(restored.sources[1].goalCreationRequested, true, "the explicit Goal-creation preference survives reload");
equal(restored.sources[1].sourceBinding?.controlPlaneInstanceId, "remote-lab-instance", "the verified instance binding survives reload");
deepEqual(
  remoteGoalCreationControlPresentation(true, "error"),
  { action: "retry", label: "retry" },
  "an unavailable requested source offers retry instead of claiming Goal authority",
);
deepEqual(
  remoteGoalCreationControlPresentation(true, "ready"),
  { action: "disable", label: "ready" },
  "only a verified capability handshake displays Goal creation as ready",
);

const withoutTunnel = removeStatusSource(restored, restored.sources[1].id);
equal(withoutTunnel.sources.length, 2, "removing one tunnel preserves the other named source");
assert(withoutTunnel.sources.some((source) => source.label === "Remote build host"), "the second SSH source remains selectable");
deepEqual(removeStatusSource(withoutTunnel, localStatusSource.id).sources, withoutTunnel.sources, "the built-in local source cannot be removed");

equal(activeStatusSourceForUrl(initial, null, localStatusSource.statusUrl, baseHref).id, "local", "idle defaults to the local source");
equal(activeStatusSourceForUrl(added.catalog, added.source.statusUrl, localStatusSource.statusUrl, baseHref).id, added.source.id, "an in-flight selection wins over the previously loaded local source");
equal(activeStatusSourceForUrl(added.catalog, null, added.source.statusUrl, baseHref).id, added.source.id, "with no in-flight request the loaded source is active");

const configuredHosts = parseConfiguredSshHostCatalog({
  ok: true,
  schema_version: "ssh_host_catalog_v0",
  hosts: [{ alias: "remote-lab" }, { alias: "*.example" }, { alias: "remote-lab" }, { alias: "jump_box" }],
});
equal(defaultConfiguredSshHostsUrl, "/ssh-hosts", "configured Host discovery stays on the active local Dashboard origin");
deepEqual(configuredHosts.hosts, [{ alias: "remote-lab" }, { alias: "jump_box" }], "only explicit safe SSH aliases enter the browser catalog");
const configuredDraft = configuredSshTunnelDraft("remote-lab", "8876");
assert("command" in configuredDraft, "a configured Host and valid local port produce a tunnel draft");
equal(configuredDraft.command, "ssh -N -L 8876:127.0.0.1:8767 remote-lab", "the UI forwards the complete remote control-plane service");
equal(configuredDraft.statusUrl, "http://127.0.0.1:8876/status.json", "the selected Host maps to the loopback-only status source");
assert("error" in configuredSshTunnelDraft("remote-lab", "22"), "privileged local ports fail closed");

console.log("status source catalog smoke: ok");
