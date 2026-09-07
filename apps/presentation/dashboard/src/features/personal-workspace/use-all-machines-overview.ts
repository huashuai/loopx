import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchMachineStatusPayload,
  MachineStatusLoadError,
} from "../../data/local-status-query";
import type { StatusPayload } from "../../data/status";
import type { StatusSource } from "../../data/status-source-catalog";
import {
  buildAllMachinesOverview,
  type MachineObservation,
} from "./all-machines-model";
import type { WorkspaceModel } from "./personal-workspace-model";

export const MACHINE_REFRESH_INTERVAL_MS = 60_000;

export type MachineObservationUpdate = {
  generation: number;
  source: StatusSource;
  phase: MachineObservation["phase"];
  lastAttemptAt: number;
  lastSuccessAt?: number;
  model?: WorkspaceModel | null;
  currentError?: string | null;
};

export function applyMachineObservationUpdate(
  current: ReadonlyMap<string, MachineObservation>,
  sourceId: string,
  update: MachineObservationUpdate,
  activeGeneration: number,
) {
  if (update.generation !== activeGeneration) return current;
  const previous = current.get(sourceId);
  const next = new Map(current);
  next.set(sourceId, {
    source: update.source,
    phase: update.phase,
    lastAttemptAt: update.lastAttemptAt,
    lastSuccessAt: update.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
    model: update.model === undefined ? previous?.model ?? null : update.model,
    currentError: update.currentError ?? null,
  });
  return next;
}

function publicMachineLoadError(error: unknown) {
  if (error instanceof MachineStatusLoadError) return error.code;
  return "unavailable";
}

export async function loadAllMachineSnapshots<T>(options: {
  sources: readonly StatusSource[];
  generation: number;
  signal: AbortSignal;
  fetchSnapshot: (source: StatusSource, signal: AbortSignal) => Promise<T>;
  buildModel: (snapshot: T) => WorkspaceModel;
  onObservation: (sourceId: string, update: MachineObservationUpdate) => void;
  now?: () => number;
}) {
  const pending = [...options.sources];
  const now = options.now ?? Date.now;

  async function worker() {
    while (pending.length > 0 && !options.signal.aborted) {
      const source = pending.shift();
      if (!source) return;
      options.onObservation(source.id, {
        generation: options.generation,
        source,
        phase: "loading",
        lastAttemptAt: now(),
        currentError: null,
      });
      try {
        const snapshot = await options.fetchSnapshot(source, options.signal);
        if (options.signal.aborted) return;
        const observedAt = now();
        options.onObservation(source.id, {
          generation: options.generation,
          source,
          phase: "ready",
          lastAttemptAt: observedAt,
          lastSuccessAt: observedAt,
          model: options.buildModel(snapshot),
          currentError: null,
        });
      } catch (error) {
        if (options.signal.aborted) return;
        const currentError = publicMachineLoadError(error);
        options.onObservation(source.id, {
          generation: options.generation,
          source,
          phase: "error",
          lastAttemptAt: now(),
          model: currentError === "binding_required" || currentError === "binding_mismatch"
            ? null
            : undefined,
          currentError,
        });
      }
    }
  }

  await Promise.all([worker(), worker()]);
}

export function useAllMachinesOverview(options: {
  enabled: boolean;
  sources: readonly StatusSource[];
  buildModel: (payload: StatusPayload) => WorkspaceModel;
}) {
  const [observations, setObservations] = useState<Map<string, MachineObservation>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [lastCycleCompletedAt, setLastCycleCompletedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const buildModelRef = useRef(options.buildModel);
  buildModelRef.current = options.buildModel;
  const sourcesRef = useRef(options.sources);
  sourcesRef.current = options.sources;
  const sourceSignature = options.sources.map((source) => (
    `${source.id}:${source.statusUrl}:${source.sourceBinding?.controlPlaneInstanceId ?? "unbound"}`
  )).join("|");

  const refreshAll = useCallback(async () => {
    if (!options.enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    const activeSourceIds = new Set(sourcesRef.current.map((source) => source.id));
    setObservations((current) => new Map(
      [...current].filter(([sourceId]) => activeSourceIds.has(sourceId)),
    ));
    setRefreshing(true);
    await loadAllMachineSnapshots({
      sources: sourcesRef.current,
      generation,
      signal: controller.signal,
      fetchSnapshot: (source, signal) => fetchMachineStatusPayload(source, window.location.href, signal),
      buildModel: (payload) => buildModelRef.current(payload),
      onObservation: (sourceId, update) => {
        setObservations((current) => applyMachineObservationUpdate(
          current,
          sourceId,
          update,
          generationRef.current,
        ) as Map<string, MachineObservation>);
      },
    });
    if (generationRef.current === generation && !controller.signal.aborted) {
      const completedAt = Date.now();
      setClock(completedAt);
      setLastCycleCompletedAt(completedAt);
      setRefreshing(false);
    }
  }, [options.enabled, sourceSignature]);

  useEffect(() => {
    if (!options.enabled) {
      abortRef.current?.abort();
      setRefreshing(false);
      return;
    }
    void refreshAll();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshAll();
    }, MACHINE_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      abortRef.current?.abort();
    };
  }, [options.enabled, refreshAll]);

  return {
    overview: useMemo(() => buildAllMachinesOverview(observations, clock), [clock, observations]),
    refreshing,
    refreshAll,
    lastCycleCompletedAt,
  };
}
