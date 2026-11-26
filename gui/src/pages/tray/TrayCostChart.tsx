import { useState } from 'react';
import { formatTokens } from '../../format-tokens';
import type { Locale, TFn } from '../../i18n/shared';
import { UsageCompanionChart } from '../usage-companion-chart';
import type { UsageTimeline } from '../usage-companion-utils';
import { costTotal, formatTrayCost, type ChartView, type Period } from './cost-history';

function periodLabel(start: number, end: number, period: Period, locale: Locale) {
  const formatter = new Intl.DateTimeFormat(locale, period === 'month'
    ? { year: 'numeric', month: 'short' }
    : { month: 'short', day: 'numeric' });
  return period === 'week' ? formatter.formatRange(start, end - 1) : formatter.format(start);
}

const periodLabels = { day: 'tray.historyDayShort', week: 'tray.historyWeekShort', month: 'tray.historyMonthShort' } as const;
const periods = ['day', 'week', 'month'] as const;
const colors = ['#488df4', '#efa644', '#47b784', '#ae78eb', '#38becb', '#e37c95', '#b2b953', '#aab6cf'];
const chartColor = (index: number) => colors[index] ?? `hsl(${Math.round(index * 137.508) % 360} 68% 64%)`;
type Props = {
  period: Period | null;
  detail: ChartView | undefined;
  boundaries: readonly number[] | undefined;
  timeline: UsageTimeline | null;
  error: boolean;
  hours: number;
  locale: Locale;
  t: TFn;
  onPeriod: (period: Period | null) => void;
  onDrill: (view: ChartView) => void;
  onBack: () => void;
  onRetry: () => void;
};

export function TrayCostChart({ period, detail, boundaries, timeline, error, hours, locale, t, onPeriod, onDrill, onBack, onRetry }: Props) {
  const [hoveredStart, setHoveredStart] = useState<number | null>(null);
  const [focusedStart, setFocusedStart] = useState<number | null>(null);
  const detailLabel = detail ? periodLabel(detail.start, detail.end, detail.period, locale) : undefined;
  const barPeriod = detail?.period === 'month' ? 'week' : detail?.period === 'week' ? 'day' : period;
  const showBars = barPeriod !== null && detail?.period !== 'day' && boundaries && timeline?.costCoverage;
  const bars = showBars ? boundaries.slice(0, -1).map((start, index) => ({
    start, end: boundaries[index + 1]!, cost: costTotal(timeline, index, index + 1)!,
    requests: timeline?.bucketUsage?.requests[index], tokens: timeline?.bucketUsage?.tokens[index],
  })) : [];
  const selected = bars.find(bar => bar.start === (hoveredStart ?? focusedStart)) ?? bars.at(-1);
  const selectedIndex = selected ? bars.indexOf(selected) : -1;
  const series = (timeline?.series ?? []).filter(row => row.points.some(point => point > 0));
  const max = Math.max(0, ...bars.map(bar => bar.cost.amount));
  const money = (amount: number) => formatTrayCost({ amount, priced: 1, unpriced: 0 }, locale);
  const axisDate = new Intl.DateTimeFormat(locale, barPeriod === 'month'
    ? { month: 'short' } : { month: '2-digit', day: '2-digit' });
  const selectedText = selected && barPeriod ? [
    barPeriod === 'day'
      ? new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', weekday: 'short' }).format(selected.start)
      : periodLabel(selected.start, selected.end, barPeriod, locale),
    selected.tokens === undefined ? undefined : t('tray.historyTokenCount', { count: formatTokens(selected.tokens, locale) }),
    selected.requests === undefined ? undefined : t('pws.dashboard.requests', { count: selected.requests.toLocaleString(locale) }),
    formatTrayCost(selected.cost, locale),
  ].filter(value => value !== undefined).join(' · ') : '';
  return <>
    <div className="tray-chart-controls">
      <div className="tray-chart-tags" role="group" aria-label={t('tray.history')}>
        <button type="button" aria-pressed={period === null} onClick={() => onPeriod(null)}>{t('usage.companion.styleLine')}</button>
        <button type="button" aria-pressed={period !== null} onClick={() => onPeriod(period ?? 'day')}>{t('tray.barChart')}</button>
      </div>
      {period !== null && <div className="tray-chart-tags" role="group" aria-label={t('tray.historyPeriod')}>
        {periods.map(value => <button type="button" key={value} aria-pressed={value === period} onClick={() => onPeriod(value)}>{t(periodLabels[value])}</button>)}
      </div>}
    </div>
    {detail && <div className="tray-chart-detail">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>{t('tray.historyBack')}</button>
      <strong>{detailLabel}</strong>
    </div>}
    {bars.length > 0 && barPeriod !== null ? <>
      <div className="tray-bars-summary">
        <span>{t(detail ? 'tray.historyPeriod' : 'tray.historyRecentCount', { count: bars.length, period: t(periodLabels[barPeriod]) })}</span>
        <span>{selectedText}</span>
      </div>
      <div className="tray-bars-layout">
        <div className="tray-bars-y" aria-hidden="true"><span>{money(max)}</span><span>{money(0)}</span></div>
        <div className="tray-bars-main">
          <div className="tray-cost-bars" onPointerLeave={() => setHoveredStart(null)}>
            {bars.map(({ start, end, cost }, index) => {
              const label = periodLabel(start, end, barPeriod, locale);
              const amount = formatTrayCost(cost, locale);
              const parts = series.map((row, colorIndex) => ({ id: row.id, colorIndex, value: row.points[index] ?? 0 }))
                .filter(part => part.value > 0);
              return <button type="button" key={start} title={label + ' · ' + amount} aria-label={label + ' · ' + amount}
                data-highlighted={start === selected?.start}
                onPointerEnter={() => setHoveredStart(start)} onFocus={() => setFocusedStart(start)} onBlur={() => setFocusedStart(null)}
                onClick={() => { setHoveredStart(null); setFocusedStart(null); onDrill({ period: barPeriod, start, end }); }}>
                <span className="tray-cost-stack" aria-hidden="true">
                  {max > 0 && parts.length > 0 && <span className="tray-cost-segments" style={{ height: (cost.amount / max * 100) + '%' }}>
                    {parts.map(part => <span key={part.id} style={{ flexGrow: part.value / cost.amount * 100,
                      minHeight: `min(2px, ${100 / parts.length}%)`, backgroundColor: chartColor(part.colorIndex) }} />)}
                  </span>}
                </span>
              </button>;
            })}
          </div>
          <div className="tray-bars-x" aria-hidden="true">
            {bars.map(({ start }, index) => {
              const first = index === 0;
              const last = index === bars.length - 1;
              const step = Math.max(1, Math.ceil(bars.length / 7));
              if (!first && !last && (index % step !== 0 || index >= bars.length - 2)) return null;
              const left = first ? 0 : last ? 100 : (index + 0.5) / bars.length * 100;
              return <span key={start} data-edge={first ? 'first' : last ? 'last' : undefined} style={{ left: left + '%' }}>{axisDate.format(start)}</span>;
            })}
          </div>
        </div>
      </div>
      <div className="usage-companion-legend">
        {series.map((row, index) => <span className="usage-companion-legend-item" key={row.id} title={row.id}>
          <span className="usage-companion-swatch" style={{ backgroundColor: chartColor(index) }} aria-hidden="true" />
          <span>{row.id === 'other' ? t('tray.historyOther') : series.some(other => other !== row && other.model === row.model) ? row.id : row.model}</span>
          <span>{(row.points[selectedIndex] ?? 0) > 0 ? money(row.points[selectedIndex]!) : '—'}</span>
        </span>)}
      </div>
      {timeline?.truncated && <p className="muted text-caption">{t('usage.companion.olderRecordsSkipped')}</p>}
    </> : <UsageCompanionChart timeline={timeline} chartStyle="line" hours={hours} loading={!timeline && !error}
      error={error ? t('usage.companion.timelineUnavailable') : null} onRetry={onRetry} locale={locale} t={t}
      formatValue={value => formatTrayCost({ amount: value, priced: 1, unpriced: 0 }, locale)}
      chartLabel={t('tray.apiEstimate')} />}
    {!!timeline?.missingMeasurements && <p className="muted text-caption">{t('tray.historyPartial')}</p>}
  </>;
}
