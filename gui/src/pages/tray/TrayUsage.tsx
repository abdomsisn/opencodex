import type { Locale, TFn } from '../../i18n/shared';
import { formatTokens } from '../../format-tokens';
import type { CompanionSettings } from '../usage-companion-utils';
import { finite, measuredTotals, type TrayTotals, type TrayUsage } from '../tray-data';
import { formatTrayCost, type CostTotal } from './cost-history';
import { TrayCard } from './TrayParts';

const incomplete = (data: TrayUsage | null | undefined) => data?.usageIncomplete || data?.historyTruncated || data?.entriesTruncated;

function numberFormatter(locale: string) {
  return (value: unknown) => finite(value) ? formatTokens(value, locale) : '—';
}

function Totals({ raw, cost, locale, t }: { raw: TrayTotals | undefined; cost: CostTotal | undefined; locale: Locale; t: TFn }) {
  const number = numberFormatter(locale);
  const data = raw ? measuredTotals(raw) : undefined;
  const cached = data?.cacheReadInputTokens ?? data?.cachedInputTokens;
  const percent = finite(cached) && finite(data?.inputTokens) && data.inputTokens > 0 ? `${Math.round(cached / data.inputTokens * 100)}%` : '—';
  return <dl>
    <div className="tray-figure" title={t(cost?.unpriced ? 'tray.historyPartial' : 'logs.metric.estimatedCostTitle')}>
      <dt>{t('tray.apiEstimate')}</dt><dd aria-label={t('tray.apiEstimate') + ' ' + formatTrayCost(cost, locale)}>{formatTrayCost(cost, locale)}</dd>
    </div>
    <div><dt>{t('usage.card.totalTokens')}</dt><dd>{number(data?.totalTokens)}</dd></div>
    <div><dt>{t('tray.input')}</dt><dd>{number(data?.inputTokens)} <small title={t('usage.card.cachedTokens')}>{t('tray.cached', { percent })}</small></dd></div>
    <div><dt>{t('tray.output')}</dt><dd>{number(data?.outputTokens)}</dd></div>
    <div><dt>{t('usage.card.requests')}</dt><dd>{number(data?.requests)}</dd></div>
    {finite(data?.requests) && data.requests > 0 && finite(data.measuredRequests) && data.measuredRequests < data.requests && <div className="tray-coverage" title={t('usage.coverage.note')}><dt>{t('usage.card.coverage')}</dt><dd>{Math.round(data.measuredRequests / data.requests * 100)}%</dd></div>}
  </dl>;
}

function Heading({ label, data, t }: { label: string; data: TrayUsage | null | undefined; t: TFn }) {
  return <h3>{label}{incomplete(data) && <span title={t('usage.incomplete')} aria-label={t('usage.incomplete')}> *</span>}</h3>;
}

/** Today and the last 30 days side by side; the headline figure is the estimated API cost. */
export function TrayTotalsCard({ usage, costs, costTruncated, settings, locale, t }: { usage: (TrayUsage | null)[]; costs: (CostTotal | undefined)[]; costTruncated?: boolean; settings: CompanionSettings; locale: Locale; t: TFn }) {
  return <TrayCard className="tray-totals" label={t('usage.section.overview')}>
    <div className="tray-totals-grid">
      {settings.showToday && <div><Heading label={t('tray.today')} data={usage[0]} t={t} /><Totals raw={usage[0]?.summary} cost={costs[0]} locale={locale} t={t} /></div>}
      <div><Heading label={t('usage.range.30d')} data={usage[1]} t={t} /><Totals raw={usage[1]?.summary} cost={costs[1]} locale={locale} t={t} /></div>
    </div>
    {costTruncated && <p className="muted text-caption">{t('usage.companion.olderRecordsSkipped')}</p>}
  </TrayCard>;
}

/** Today's models, busiest first as the runtime sorts them. */
export function TrayModelsCard({ usage, locale, t }: { usage: TrayUsage; locale: string; t: TFn }) {
  const number = numberFormatter(locale);
  return <TrayCard className="tray-models" title={t('usage.section.models')}>
    <ul>
      {usage.models.map(row => <li key={`${row.provider}/${row.model}`}>
        <span className="tray-model-name" title={`${row.provider}/${row.model}`}>{row.model}</span>
        <span className="tray-model-metrics">
          <span title={t('usage.card.requests')}>{t('pws.dashboard.requests', { count: number(row.requests) })}</span>
          <span title={t('usage.card.totalTokens')}>{number(measuredTotals(row).totalTokens)}</span>
        </span>
      </li>)}
    </ul>
  </TrayCard>;
}
