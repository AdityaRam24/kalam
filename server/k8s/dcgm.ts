// GPU readings from the NVIDIA DCGM exporter.
//
// The GPU Operator runs `nvidia-dcgm-exporter` as a DaemonSet on every GPU
// node, and with its kubelet pod-resources mapping each GPU series carries the
// pod/namespace/container that holds the device. That is the whole per-model
// view in ONE HTTP GET per node, with no exec into workload pods, no per-pod
// probe cap, and no dependency on nvidia-smi being inside the model's image.
// It also sees GPUs that NO pod holds — the idle capacity exec can never see.
//
// The exporter is reached through the API server's pod proxy
// (`kubectl get --raw /api/v1/namespaces/<ns>/pods/<pod>:<port>/proxy/metrics`),
// which needs only `get pods/proxy`. Pure parsing lives here and is tested in
// server/__tests__/dcgm.test.ts.

import type { GpuReading } from './gpu.js';

export interface PromSample { name: string; labels: Record<string, string>; value: number }

/** Parse Prometheus text exposition format. Comments, HELP and TYPE are skipped. */
export function parsePromText(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const value = Number(m[4]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (m[3]) {
      for (const lm of m[3].matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[lm[1]] = lm[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      }
    }
    out.push({ name: m[1], labels, value });
  }
  return out;
}

export interface DcgmGpu extends GpuReading {
  node: string;
  /** The pod holding this GPU, when the exporter maps devices to pods. */
  namespace?: string;
  pod?: string;
  container?: string;
  /** MIG GPU-instance id, when this is a MIG slice. */
  migInstance?: string;
  /** Last XID error code reported (0 = none). */
  xid?: number | null;
  /** DCGM profiling: fraction of time the graphics/compute engine was busy, as %. */
  engineActivePct?: number | null;
}

const FIELD: Record<string, keyof DcgmGpu | 'fbFree' | 'fbReserved'> = {
  DCGM_FI_DEV_GPU_UTIL: 'utilPct',
  DCGM_FI_DEV_MEM_COPY_UTIL: 'memUtilPct',
  DCGM_FI_DEV_FB_USED: 'memUsedMiB',
  DCGM_FI_DEV_FB_FREE: 'fbFree',
  DCGM_FI_DEV_FB_RESERVED: 'fbReserved',
  DCGM_FI_DEV_GPU_TEMP: 'tempC',
  DCGM_FI_DEV_MEMORY_TEMP: 'memTempC',
  DCGM_FI_DEV_POWER_USAGE: 'powerW',
  DCGM_FI_DEV_SM_CLOCK: 'smClockMHz',
  DCGM_FI_DEV_MEM_CLOCK: 'memClockMHz',
  DCGM_FI_DEV_XID_ERRORS: 'xid',
  DCGM_FI_DEV_ECC_DBE_VOL_TOTAL: 'eccUncorrected',
  DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS: 'eccUncorrected',
  DCGM_FI_PROF_GR_ENGINE_ACTIVE: 'engineActivePct',
};

/** One exporter's /metrics → one reading per GPU (or MIG slice). */
export function parseDcgm(text: string, node: string): DcgmGpu[] {
  const byKey = new Map<string, DcgmGpu & { fbFree?: number; fbReserved?: number }>();
  for (const s of parsePromText(text)) {
    const field = FIELD[s.name];
    if (!field) continue;
    const l = s.labels;
    const uuid = l.UUID || l.uuid || `${node}/gpu${l.gpu ?? '?'}`;
    const key = `${uuid}/${l.GPU_I_ID ?? ''}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        node: l.Hostname || node,
        index: Number(l.gpu) || 0,
        uuid,
        name: l.modelName || '',
        busId: l.pci_bus_id || '',
        driver: l.DCGM_FI_DRIVER_VERSION || '',
        pstate: '', tempC: null, utilPct: null, memUtilPct: null, memTotalMiB: null, memUsedMiB: null, memFreeMiB: null,
        powerW: null, powerLimitW: null, smClockMHz: null, memClockMHz: null, maxSmClockMHz: null, fanPct: null,
        persistence: '', computeMode: '', pcie: '',
        mig: l.GPU_I_PROFILE || (l.GPU_I_ID ? 'Enabled' : undefined),
        migInstance: l.GPU_I_ID || undefined,
        processes: [],
        source: 'dcgm',
      };
      byKey.set(key, g);
    }
    // The pod mapping can be on any series; take it from the first that has it.
    if (l.pod && !g.pod) { g.pod = l.pod; g.namespace = l.namespace; g.container = l.container; }
    // Profiling is the honest "how busy": GPU_UTIL only means "a kernel was
    // running", and reads 100% for one tiny kernel in a loop.
    if (field === 'engineActivePct') g.engineActivePct = s.value * 100;
    else (g as any)[field] = s.value;
  }
  return [...byKey.values()].map(({ fbFree, fbReserved, ...g }) => {
    if (g.memUsedMiB !== null && fbFree !== undefined) {
      g.memFreeMiB = fbFree;
      g.memTotalMiB = g.memUsedMiB + fbFree + (fbReserved || 0);
    }
    return g;
  }).sort((a, b) => a.node.localeCompare(b.node) || a.index - b.index || String(a.migInstance).localeCompare(String(b.migInstance)));
}

/** Running DCGM exporter pods in a pod list, with the port their /metrics is on. */
export function dcgmExporters(pods: any[]): Array<{ namespace: string; pod: string; node: string; port: number }> {
  const out: Array<{ namespace: string; pod: string; node: string; port: number }> = [];
  for (const p of pods || []) {
    const labels = p?.metadata?.labels || {};
    const isExporter = labels.app === 'nvidia-dcgm-exporter' || labels['app.kubernetes.io/name'] === 'dcgm-exporter' ||
      /dcgm-exporter/.test(p?.metadata?.name || '');
    if (!isExporter || p?.status?.phase !== 'Running' || p?.metadata?.deletionTimestamp) continue;
    let port = 9400;
    for (const c of p?.spec?.containers || []) {
      const named = (c.ports || []).find((x: any) => x.name === 'metrics' || x.containerPort === 9400);
      if (named) { port = Number(named.containerPort) || port; break; }
    }
    out.push({ namespace: p.metadata.namespace, pod: p.metadata.name, node: p?.spec?.nodeName || '', port });
  }
  return out;
}
