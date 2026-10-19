import { Catalog } from "./catalog";
import { GrpcInvokeRequest, GrpcInvokeResult, invokeGrpc } from "./grpcInvoke";
import { invokeHttp } from "./httpInvoke";

export interface StressOptions {
  id: string;
  concurrency: number;
  total: number;
}

export interface StressSample {
  index: number;
  ok: boolean;
  status: string;
  ms: number;
  error?: string;
}

export interface StressProgress {
  id: string;
  type: "progress";
  done: number;
  total: number;
  ok: number;
  fail: number;
}

export interface StressSummary {
  id: string;
  type: "done";
  total: number;
  ok: number;
  fail: number;
  durationMs: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  samples: StressSample[];
  cancelled?: boolean;
}

const running = new Map<string, { cancel: boolean }>();

export function cancelStress(id: string): void {
  const job = running.get(id);
  if (job) job.cancel = true;
}

export async function runStress(
  catalog: Catalog,
  base: GrpcInvokeRequest,
  options: StressOptions,
  onProgress: (progress: StressProgress) => void,
): Promise<StressSummary> {
  const concurrency = Math.min(10, Math.max(1, Math.floor(options.concurrency || 1)));
  const total = Math.min(200, Math.max(1, Math.floor(options.total || 1)));
  const job = { cancel: false };
  running.set(options.id, job);

  const samples: StressSample[] = [];
  let ok = 0;
  let fail = 0;
  let next = 0;
  const started = Date.now();

  const worker = async () => {
    while (!job.cancel) {
      const index = next++;
      if (index >= total) return;
      const payload = { ...base, id: `${options.id}-${index}` };
      const result: GrpcInvokeResult = (payload as GrpcInvokeRequest & { protocol?: string }).protocol === "http"
        ? await invokeHttp(payload)
        : await invokeGrpc(catalog, payload);
      samples.push({
        index,
        ok: result.ok,
        status: result.status,
        ms: result.ms,
        error: result.error,
      });
      if (result.ok) ok += 1;
      else fail += 1;
      onProgress({
        id: options.id,
        type: "progress",
        done: samples.length,
        total,
        ok,
        fail,
      });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  running.delete(options.id);

  const durationMs = Math.max(1, Date.now() - started);
  const latencies = samples.map((item) => item.ms).sort((a, b) => a - b);
  return {
    id: options.id,
    type: "done",
    total: samples.length,
    ok,
    fail,
    durationMs,
    rps: Number(((samples.length * 1000) / durationMs).toFixed(2)),
    avgMs: avg(latencies),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    minMs: latencies[0] ?? 0,
    maxMs: latencies[latencies.length - 1] ?? 0,
    samples: samples.sort((a, b) => a.index - b.index).slice(0, 50),
    cancelled: job.cancel,
  };
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(1));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}
