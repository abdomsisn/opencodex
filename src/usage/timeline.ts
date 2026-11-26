import { baseProviderLabel } from "../providers/label";
import { cacheTokensFromUsage, computeEntryCost, usageAttributions } from "./summary";
import { estimateAttemptCost, serviceTierContext } from "./cost";
import type { PersistedUsageEntry } from "./log";
import { usageDisplayTotalTokens } from "./totals";

export type TimelineMetric = "total" | "input" | "output" | "cached" | "cost";
export type TimelineAggregation = "sum" | "average" | "max";
export type TimelineGrouping = "model" | "modelAccount";
export const TIMELINE_HOURS = [6, 24, 72, 168] as const;

export interface TimelineQuery {
  hours: typeof TIMELINE_HOURS[number];
  bucketMinutes: number;
  metric: TimelineMetric;
  aggregation: TimelineAggregation;
  grouping: TimelineGrouping;
  models: string[] | null;
  hiddenProviders: string[];
  now: number;
  boundaries?: number[];
}

export interface TimelineSeries {
  id: string;
  provider: string;
  model: string;
  accountLogLabel?: string;
  total: number;
  points: number[];
}

export interface UsageTimeline {
  appliedFilters: { models: string[] | null; hiddenProviders: string[] };
  start: number;
  end: number;
  bucketSeconds: number;
  buckets: number;
  metric: TimelineMetric;
  aggregation: TimelineAggregation;
  grouping: TimelineGrouping;
  series: TimelineSeries[];
  availableModels: string[];
  missingMeasurements: number;
  truncated: boolean;
  costCoverage?: { priced: number[]; unpriced: number[] };
  bucketUsage?: { requests: number[]; tokens: number[] };
}

const METRICS: readonly TimelineMetric[] = ["total", "input", "output", "cached", "cost"];
const AGGREGATIONS: readonly TimelineAggregation[] = ["sum", "average", "max"];
const GROUPINGS: readonly TimelineGrouping[] = ["model", "modelAccount"];

function enumValue<T extends string>(value: string | null, values: readonly T[], fallback: T): T | { error: string } {
  if (value === null || value === "") return fallback;
  return values.includes(value as T) ? value as T : { error: `invalid value for parameter: ${value}` };
}

export function isTimelineModelId(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

/**
 * Pool accounts log as `openai-p<hex6>` (and older rows as `openai-main`/`chatgpt`), so the raw
 * provider would draw one line per account for the same model. The usage summary already folds these
 * through `baseProviderLabel`; the timeline keys on the same label so both views agree.
 */
function timelineModelId(provider: string, model: string): string {
  return `${baseProviderLabel(provider)}/${model}`;
}

/** A saved selection may still name a pool account (`openai-p6bc633/gpt-5`); it selects the merged row. */
export function normalizeTimelineModelId(id: string): string {
  const cut = id.indexOf("/");
  return timelineModelId(id.slice(0, cut), id.slice(cut + 1));
}

/**
 * In account grouping the pool suffix is the account when no explicit label was stamped. Codex pool
 * accounts and Anthropic OAuth accounts (`formatAnthropicProviderForLog`) both log that way.
 */
function poolAccountLabel(provider: string): string | undefined {
  if (baseProviderLabel(provider) === provider) return undefined;
  return provider.match(/-(main|p[a-f0-9]{6})$/)?.[1];
}

function parseModels(raw: string | null): string[] | null | { error: string } {
  if (raw === null || raw.trim() === "") return null;
  const models = raw.split(",").map(model => model.trim());
  if (models.length > 100) return { error: "models must contain at most 100 identifiers" };
  if (models.some(model => !isTimelineModelId(model))) {
    return { error: "models must contain provider/model identifiers" };
  }
  return [...new Set(models)];
}

export function parseTimelineQuery(params: URLSearchParams, now: number): TimelineQuery | { error: string } {
  const rawHours = params.get("hours") ?? "24";
  const hoursNumber = Number(rawHours);
  if (!TIMELINE_HOURS.includes(hoursNumber as typeof TIMELINE_HOURS[number])) {
    return { error: "hours must be one of 6, 24, 72, 168" };
  }
  const bucketMinutes = Number(params.get("bucketMinutes") ?? "60");
  if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 1440) {
    return { error: "bucketMinutes must be an integer from 1 through 1440" };
  }
  const buckets = Math.ceil(hoursNumber * 60 / bucketMinutes);
  if (buckets > 2000) return { error: "timeline bucket count must not exceed 2000" };
  const metric = enumValue(params.get("metric"), METRICS, "total");
  if (typeof metric !== "string") return metric;
  const aggregation = enumValue(params.get("aggregation"), AGGREGATIONS, "sum");
  if (typeof aggregation !== "string") return aggregation;
  const grouping = enumValue(params.get("grouping"), GROUPINGS, "model");
  if (typeof grouping !== "string") return grouping;
  const models = parseModels(params.get("models"));
  if (typeof models === "object" && models !== null && "error" in models) return models;
  const hiddenProviders = params.getAll("hiddenProvider");
  if (hiddenProviders.length > 100 || hiddenProviders.some(value => !value || /\s/.test(value))) {
    return { error: "hiddenProvider must contain at most 100 nonblank provider names" };
  }
  if (!Number.isFinite(now)) return { error: "now must be finite" };
  const rawBoundaries = params.get("boundaries");
  let boundaries: number[] | undefined;
  if (rawBoundaries !== null) {
    if (rawBoundaries.length > 600) return { error: "too many calendar boundaries" };
    boundaries = rawBoundaries.split(",").map(value => value.trim() ? Number(value) : NaN);
    if (boundaries.length < 2 || boundaries.length > 32 || boundaries.some((value, index) =>
      !Number.isSafeInteger(value) || value < 0 || value > now + 32 * 86_400_000
      || (index > 0 && value <= boundaries![index - 1]!))
      || boundaries.at(-1)! - boundaries[0]! > 370 * 86_400_000) {
      return { error: "invalid calendar boundaries" };
    }
  }
  return {
    hours: hoursNumber as TimelineQuery["hours"],
    bucketMinutes,
    metric,
    aggregation,
    grouping,
    models: models as string[] | null,
    hiddenProviders: [...new Set(hiddenProviders)].sort(),
    now,
    ...(boundaries ? { boundaries } : {}),
  };
}

interface SeriesState {
  provider: string;
  model: string;
  accountLogLabel?: string;
  points: number[];
  requests: Map<number, Map<string, number>>;
}

function metricValue(metric: TimelineMetric, attribution: ReturnType<typeof usageAttributions>[number]): number | undefined {
  if (metric === "total") return usageDisplayTotalTokens(attribution.usage, attribution.totalTokens);
  if (metric === "input") return attribution.usage?.inputTokens;
  if (metric === "output") return attribution.usage?.outputTokens;
  return cacheTokensFromUsage(attribution.usage).read;
}

/** Subscription routes use the corresponding API quote when it is available. */
function timelineCost(entry: PersistedUsageEntry, index: number, original: ReturnType<typeof computeEntryCost>): number | undefined {
  const attempt = entry.attempts?.[index];
  const target = attempt ?? entry;
  if (baseProviderLabel(target.provider) === "openai" && !target.model.includes("/")) {
    const apiQuote = estimateAttemptCost({
      ...target, ordinal: index, provider: "openai-apikey", allowModelLevelFallback: false,
    }, undefined, serviceTierContext(entry));
    if (apiQuote) return apiQuote.cost.total;
  }
  return (attempt ? original.attemptEstimates?.[index] : original.estimate)?.cost.total;
}

export function createTimelineAccumulator(query: TimelineQuery): { add(entry: PersistedUsageEntry): void; finish(): UsageTimeline } {
  const bucketSeconds = query.bucketMinutes * 60;
  const buckets = query.boundaries ? query.boundaries.length - 1 : Math.ceil(query.hours * 60 / query.bucketMinutes);
  const end = query.boundaries ? query.boundaries.at(-1)! / 1000 : (Math.floor(query.now / 1000 / bucketSeconds) + 1) * bucketSeconds;
  const start = query.boundaries ? query.boundaries[0]! / 1000 : end - buckets * bucketSeconds;
  const startMs = start * 1000;
  const endMs = end * 1000;
  const series = new Map<string, SeriesState>();
  const availableModels = new Set<string>();
  const hiddenProviders = new Set(query.hiddenProviders);
  const selectedModels = query.models === null ? null : new Set(query.models.map(normalizeTimelineModelId));
  let missingMeasurements = 0;
  const priced = Array<number>(buckets).fill(0);
  const unpriced = Array<number>(buckets).fill(0);
  const bucketRequests = Array<number>(buckets).fill(0);
  const bucketTokens = Array<number>(buckets).fill(0);

  function add(entry: PersistedUsageEntry): void {
    if (entry.timestamp < startMs || entry.timestamp >= endMs) return;
    const bucket = query.boundaries ? query.boundaries.findIndex(boundary => boundary > entry.timestamp) - 1
      : Math.floor((entry.timestamp - startMs) / (bucketSeconds * 1000));
    if (bucket < 0 || bucket >= buckets) return;
    let cost: ReturnType<typeof computeEntryCost> | undefined;
    let included = false;
    for (const [index, attribution] of usageAttributions(entry).entries()) {
      const provider = baseProviderLabel(attribution.provider);
      if (hiddenProviders.has(attribution.provider) || hiddenProviders.has(provider)) continue;
      const modelId = timelineModelId(attribution.provider, attribution.model);
      availableModels.add(modelId);
      if (selectedModels && !selectedModels.has(modelId)) continue;
      const accountLogLabel = attribution.accountLogLabel ?? poolAccountLabel(attribution.provider) ?? "unknown";
      const id = query.grouping === "model"
        ? modelId
        : `${modelId} · ${accountLogLabel}`;
      let state = series.get(id);
      if (!state) {
        state = {
          provider,
          model: attribution.model,
          ...(query.grouping === "modelAccount" ? { accountLogLabel } : {}),
          points: Array<number>(buckets).fill(0),
          requests: new Map(),
        };
        series.set(id, state);
      }
      const value = query.metric === "cost"
        ? timelineCost(entry, index, cost ??= computeEntryCost(entry))
        : metricValue(query.metric, attribution);
      if (query.metric === "cost") {
        included = true;
        bucketTokens[bucket] = (bucketTokens[bucket] ?? 0) + (metricValue("total", attribution) ?? 0);
        const counts = value === undefined ? unpriced : priced;
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
      if (value === undefined) {
        missingMeasurements += 1;
        continue;
      }
      if (query.aggregation === "sum") {
        state.points[bucket] = (state.points[bucket] ?? 0) + value;
      } else {
        let requests = state.requests.get(bucket);
        if (!requests) {
          requests = new Map();
          state.requests.set(bucket, requests);
        }
        requests.set(attribution.requestId, (requests.get(attribution.requestId) ?? 0) + value);
      }
    }
    if (included) bucketRequests[bucket] = (bucketRequests[bucket] ?? 0) + 1;
  }

  function finish(): UsageTimeline {
    const rows = [...series].map(([id, state]): { row: TimelineSeries; state: SeriesState } => {
      if (query.aggregation !== "sum") {
        for (const [bucket, requests] of state.requests) {
          let sum = 0;
          let max = -Infinity;
          for (const value of requests.values()) {
            sum += value;
            max = Math.max(max, value);
          }
          state.points[bucket] = query.aggregation === "max" ? max : sum / requests.size;
        }
      }
      const total = state.points.reduce((sum, value) => sum + value, 0);
      return {
        row: {
          id,
          provider: state.provider,
          model: state.model,
          ...(state.accountLogLabel !== undefined ? { accountLogLabel: state.accountLogLabel } : {}),
          total,
          points: state.points,
        },
        state,
      };
    }).sort((left, right) => right.row.total - left.row.total || left.row.id.localeCompare(right.row.id));
    const kept = (rows.length > 24 ? rows.slice(0, 23) : rows).map(({ row }) => row);
    if (rows.length > 24) {
      const otherPoints = Array<number>(buckets).fill(0);
      const folded = rows.slice(23);
      if (query.aggregation === "sum") {
        for (const { row } of folded) {
          for (let index = 0; index < buckets; index += 1) otherPoints[index] = (otherPoints[index] ?? 0) + (row.points[index] ?? 0);
        }
      } else {
        for (let index = 0; index < buckets; index += 1) {
          let sum = 0;
          let max = -Infinity;
          let count = 0;
          for (const { state } of folded) {
            const requests = state.requests.get(index);
            if (!requests) continue;
            for (const value of requests.values()) {
              sum += value;
              max = Math.max(max, value);
              count += 1;
            }
          }
          if (count > 0) otherPoints[index] = query.aggregation === "max" ? max : sum / count;
        }
      }
      kept.push({ id: "other", provider: "", model: "other", total: otherPoints.reduce((sum, value) => sum + value, 0), points: otherPoints });
    }
    return {
      appliedFilters: {
        models: query.models === null ? null : [...new Set(query.models)].sort(),
        hiddenProviders: [...hiddenProviders].sort(),
      },
      start,
      end,
      bucketSeconds,
      buckets,
      metric: query.metric,
      aggregation: query.aggregation,
      grouping: query.grouping,
      series: kept,
      availableModels: [...availableModels].sort(),
      missingMeasurements,
      truncated: false,
      ...(query.metric === "cost" ? {
        costCoverage: { priced, unpriced },
        bucketUsage: { requests: bucketRequests, tokens: bucketTokens },
      } : {}),
    };
  }

  return { add, finish };
}
