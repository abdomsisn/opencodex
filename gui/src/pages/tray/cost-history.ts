import type { Locale } from '../../i18n/shared';
import { companionTimelineQuery, type CompanionSettings, type UsageTimeline } from '../usage-companion-utils';

export type Period = 'day' | 'week' | 'month';
export type ChartView = { period: Period; start: number; end: number };
export interface CostTotal { amount: number; priced: number; unpriced: number }

const HOUR = 3_600_000;
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();

export function chartBoundaries(now: number, period: Period, detail?: ChartView): number[] {
  if (detail?.period === 'day') {
    const edges: number[] = [];
    for (let at = detail.start; at < detail.end; at += HOUR) edges.push(at);
    return [...edges, detail.end];
  }
  if (detail) {
    const edges = [detail.start];
    let at = detail.start;
    while (at < detail.end) {
      const date = new Date(at);
      const step = detail.period === 'month' ? (8 - date.getDay()) % 7 || 7 : 1;
      at = Math.min(addDays(date, step), detail.end);
      edges.push(at);
    }
    return edges;
  }
  const date = new Date(now);
  if (period === 'month') {
    return Array.from({ length: 7 }, (_, index) => new Date(date.getFullYear(), date.getMonth() - 5 + index, 1).getTime());
  }
  if (period === 'week') {
    const monday = new Date(addDays(date, -(date.getDay() + 6) % 7));
    return Array.from({ length: 9 }, (_, index) => addDays(monday, (index - 7) * 7));
  }
  return Array.from({ length: 31 }, (_, index) => addDays(date, index - 29));
}

export function costTimelinePath(settings: CompanionSettings, boundaries?: readonly number[]): string {
  const query = companionTimelineQuery({ ...settings, aggregation: 'sum' });
  query.set('metric', 'cost');
  if (boundaries) {
    query.set('boundaries', boundaries.join(','));
    query.set('bucketMinutes', '60');
    query.set('grouping', 'model');
  }
  return '/api/usage/timeline?' + query;
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function costTotal(timeline: UsageTimeline | null, start = 0, end?: number): CostTotal | undefined {
  if (!timeline?.costCoverage) return undefined;
  return {
    amount: timeline.series.reduce((total, row) => total + sum(row.points.slice(start, end)), 0),
    priced: sum(timeline.costCoverage.priced.slice(start, end)),
    unpriced: sum(timeline.costCoverage.unpriced.slice(start, end)),
  };
}

export function formatTrayCost(cost: CostTotal | undefined, locale: Locale) {
  if (!cost || (cost.unpriced && !cost.priced)) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2 }).format(cost.amount) + (cost.unpriced ? '*' : '');
}
