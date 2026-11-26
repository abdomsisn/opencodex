import { useEffect, useRef, useState } from 'react';
import { createBoundedFetch } from '../bounded-fetch';
import { useI18n } from '../i18n/shared';
import { companionTimelineProjection, type CompanionSettings, type CompanionSettingsResponse, type UsageTimeline } from './usage-companion-utils';
import { accountSwitchRequest, fetchTrayJson, parseTrayUsage, filterUsage, parseAccounts, providerSources, type TrayProvider, type TraySwitchKind, type TrayUsage } from './tray-data';
import { resolveTrayApiBase } from './tray-targets';
import { TrayAlert, TrayCard, TrayFooter, TrayHeader, type TrayConnection } from './tray/TrayParts';
import { chartBoundaries, costTimelinePath, costTotal, type ChartView, type Period } from './tray/cost-history';
import { TrayCostChart } from './tray/TrayCostChart';
import { TrayModelsCard, TrayTotalsCard } from './tray/TrayUsage';
import { TrayProviderCard } from './tray/TrayAccounts';

declare global { interface Window { __OPENCODEX_TRAY_VISIBLE__?: boolean } }

/** A switch that has not answered by then is reported as failed rather than left spinning. */
const SWITCH_TIMEOUT_MS = 20_000;

export interface TrayProps {
  /** Where tray requests go; the default runs App's discovery and hub-session bootstrap. */
  resolveApiBase?: (signal: AbortSignal) => Promise<string>;
}

export default function Tray({ resolveApiBase = resolveTrayApiBase }: TrayProps = {}) {
  const { t, locale } = useI18n();
  // Null until the runtime's targets are known: nothing is polled before then (#6920).
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [targetError, setTargetError] = useState(false);
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [settingsError, setSettingsError] = useState(false);
  const [usage, setUsage] = useState<(TrayUsage | null)[]>([null, null]);
  const [usageError, setUsageError] = useState(false);
  const [providers, setProviders] = useState<TrayProvider[]>([]);
  const [quotaError, setQuotaError] = useState(false);
  const [period, setPeriod] = useState<Period | null>(null);
  const [drill, setDrill] = useState<ChartView[]>([]);
  const detail = drill.at(-1);
  const chartKey = JSON.stringify([period, detail]);
  const [dailyCost, setDailyCost] = useState<UsageTimeline | null>(null);
  const [chart, setChart] = useState<{ key: string; data: UsageTimeline | null; boundaries?: number[] } | null>(null);
  const visibleChart = chart?.key === chartKey ? chart : null;
  const choosePeriod = (value: Period | null) => { setPeriod(value); setDrill([]); };
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const retry = () => { setTargetError(false); setRevision(value => value + 1); };
  // Set after a successful switch: the pending row stays busy until the reload it started lands.
  const awaitingRefresh = useRef(false);
  // A switch still in flight when the popup unmounts is cancelled and writes no state.
  const switchController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    document.documentElement.classList.add('tray-document');
    return () => {
      mounted.current = false;
      switchController.current?.abort();
      document.documentElement.classList.remove('tray-document');
    };
  }, []);
  useEffect(() => {
    if (apiBase !== null) return;
    const controller = new AbortController();
    resolveApiBase(controller.signal).then(
      base => { if (!controller.signal.aborted) setApiBase(base); },
      () => { if (!controller.signal.aborted) setTargetError(true); },
    );
    return () => controller.abort();
  }, [revision, apiBase, resolveApiBase]);
  // The same route and body the native panel sends; the dashboard session supplies the
  // credentials. The switch settles only when the reload shows the runtime's own selection.
  const switchAccount = async (provider: string, kind: TraySwitchKind, accountId: string) => {
    if (apiBase === null) return;
    setSwitching(`${provider}:${accountId}`);
    setSwitchError(null);
    const bounded = createBoundedFetch(SWITCH_TIMEOUT_MS);
    switchController.current = bounded.controller;
    try {
      const request = accountSwitchRequest(provider, kind, accountId);
      const response = await fetch(`${apiBase}${request.path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), signal: bounded.signal });
      if (!response.ok) throw new Error(String(response.status));
      if (!mounted.current) return;
      awaitingRefresh.current = true;
      retry();
    } catch {
      if (!mounted.current) return;
      setSwitching(null);
      setSwitchError(t(kind === 'codex' ? 'codexAuth.switchFailed' : 'prov.accountSwitchFail'));
    } finally {
      bounded.clear();
      if (switchController.current === bounded.controller) switchController.current = null;
    }
  };

  // Every post-await state write checks both effect disposal and the request's AbortSignal.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    if (apiBase === null) return;
    let controller: AbortController | null = null;
    let busy = false;
    let focused = true;
    let disposed = false;
    const visible = () => !document.hidden && (window.__OPENCODEX_TRAY_VISIBLE__ ?? focused);
    const load = async () => {
      if (!visible() || busy) return;
      busy = true;
      setRefreshing(true);
      let hadSuccess = false;
      const current = new AbortController();
      controller = current;
      const json = <T,>(path: string) => fetchTrayJson<T>(`${apiBase}${path}`, current.signal);
      const active = () => !disposed && !current.signal.aborted;
      try {
        // Quotas load independently: usage/settings failures must not hide account limits.
        const quotas = (async () => {
          try {
            const sources = providerSources(await json<unknown>('/api/config'));
            const rows = await Promise.all(sources.map(async source => {
              if (!source.path) return { name: source.name, switchKind: source.switchKind, accounts: [] };
              try {
                const payload = await json<Record<string, unknown>>(source.path);
                if (source.name === 'openai') {
                  try {
                    const selection = await json<{ activeCodexAccountId?: string | null }>('/api/codex-auth/active');
                    payload.activeCodexAccountId = selection.activeCodexAccountId ?? '__main__';
                  } catch { /* Missing selection is unknown, never inferred from quota. */ }
                }
                return { name: source.name, switchKind: source.switchKind, accounts: parseAccounts(payload, source.switchKind, index => t('pws.accountOrdinal', { count: index })) };
              }
              catch { return { name: source.name, switchKind: source.switchKind, accounts: [], unavailable: true }; }
            }));
            if (active()) { setProviders(rows); setQuotaError(false); hadSuccess = true; }
          } catch { if (active()) { setProviders([]); setQuotaError(true); } }
        })();
        const metrics = (async () => {
          let config: CompanionSettings;
          try {
            config = (await json<CompanionSettingsResponse>('/api/companion/settings')).settings;
            if (!config || !Array.isArray(config.hiddenProviders) || !(config.models === null || Array.isArray(config.models))) throw new Error('Invalid settings');
            if (active()) { setSettings(config); setSettingsError(false); }
          } catch { if (active()) setSettingsError(true); return; }
          const totals = Promise.allSettled(['/api/usage?range=today', '/api/usage?range=30d'].map(async path => {
            const data = parseTrayUsage(await json<unknown>(path));
            return filterUsage(data, config);
          })).then(results => {
            if (active()) {
              hadSuccess ||= results.some(result => result.status === 'fulfilled');
              setUsage(results.map(result => result.status === 'fulfilled' ? result.value : null));
              setUsageError(results.some(result => result.status === 'rejected'));
            }
          });
          const now = Date.now();
          const readCost = async (boundaries?: number[]) => {
            const data = await json<UsageTimeline>(costTimelinePath(config, boundaries));
            if (data.metric !== 'cost' || !data.costCoverage) throw new Error('Invalid cost timeline');
            const projected = companionTimelineProjection(data, config);
            if (config.models?.length === 0) {
              const zero = Array<number>(data.buckets).fill(0);
              return { ...projected, missingMeasurements: 0, costCoverage: { priced: zero, unpriced: zero },
                bucketUsage: { requests: zero, tokens: zero } };
            }
            return projected;
          };
          const dailyBoundaries = chartBoundaries(now, 'day');
          const daily = readCost(dailyBoundaries).then(data => {
            if (active()) { setDailyCost(data); hadSuccess = true; }
            return data;
          }, () => {
            if (active()) setDailyCost(null);
            return null;
          });
          const chartLoad = (async () => {
            if (!config.showChart) return;
            const boundaries = period === null ? undefined : chartBoundaries(now, period, detail);
            try {
              const data = period === 'day' && !detail ? await daily : await readCost(boundaries);
              if (active()) setChart({ key: chartKey, data, boundaries });
            } catch { if (active()) setChart({ key: chartKey, data: null }); }
          })();
          await Promise.allSettled([totals, daily, chartLoad]);
        })();
        await Promise.allSettled([quotas, metrics]);
      } finally {
        busy = false;
        if (active()) {
          setRefreshing(false);
          if (hadSuccess) setUpdatedAt(Date.now());
          if (awaitingRefresh.current) { awaitingRefresh.current = false; setSwitching(null); }
        }
        if (!disposed && current.signal.aborted && visible()) void load();
      }
    };
    const changed = () => { if (!visible()) { controller?.abort(); } else void load(); };
    const blur = () => { focused = false; changed(); };
    const focus = () => { focused = true; changed(); };
    const nativeVisibility = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail;
      if (typeof value === 'boolean') window.__OPENCODEX_TRAY_VISIBLE__ = value;
      changed();
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    window.addEventListener('opencodex:tray-visibility', nativeVisibility);
    return () => {
      disposed = true; controller?.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
      window.removeEventListener('opencodex:tray-visibility', nativeVisibility);
    };
  }, [revision, apiBase, t, chartKey, period, detail]);

  const hiddenProviders = new Set(settings?.hiddenProviders ?? []);
  // Read off the popover's own requests: the runtime answered, could not be reached, or has not yet.
  const connection: TrayConnection = targetError || (quotaError && settingsError) ? 'down' : updatedAt !== null ? 'up' : 'loading';
  const updated = t('tray.updated', { time: updatedAt === null ? '—' : new Date(updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) });
  return <main className="tray-page">
    <TrayHeader connection={connection} refreshing={refreshing} onRefresh={retry} t={t} />
    {targetError && <TrayAlert onRetry={retry} t={t}>{t('startup.tray.unavailable')}</TrayAlert>}
    {settingsError && <TrayAlert onRetry={retry} t={t}>{t('usage.companion.settingsUnavailable')}</TrayAlert>}
    {!settings && !settingsError && !targetError && <p role="status" className="tray-loading">{t('common.loading')}</p>}
    {(settings?.showAccounts ?? true) && <section className="tray-providers" aria-label={t('usage.section.providers')}>
      {quotaError && <TrayAlert onRetry={retry} t={t}>{t('startup.tray.unavailable')}</TrayAlert>}
      {switchError && <TrayAlert t={t}>{switchError}</TrayAlert>}
      {providers.filter(provider => !hiddenProviders.has(provider.name)).map(provider => <TrayProviderCard key={provider.name} provider={provider} switching={switching} onSwitch={(name, kind, id) => void switchAccount(name, kind, id)} locale={locale} t={t} />)}
    </section>}
    {settings && <TrayTotalsCard usage={usage} costs={[costTotal(dailyCost, -1), costTotal(dailyCost)]} costTruncated={dailyCost?.truncated} settings={settings} locale={locale} t={t} />}
    {usageError && <TrayAlert onRetry={retry} t={t}>{t('usage.loadError')}</TrayAlert>}
    {settings?.showChart && <TrayCard className="tray-chart" label={t('tray.apiEstimate')}>
      <TrayCostChart period={period} detail={detail} boundaries={visibleChart?.boundaries} timeline={visibleChart?.data ?? null}
        error={visibleChart?.data === null && visibleChart !== null} hours={settings.chartHours} onRetry={retry} locale={locale} t={t}
        onPeriod={choosePeriod} onDrill={view => setDrill(current => [...current, view])} onBack={() => setDrill(current => current.slice(0, -1))} />
    </TrayCard>}
    {settings?.showModels && !!usage[0]?.models.length && <TrayModelsCard usage={usage[0]} locale={locale} t={t} />}
    <TrayFooter updated={updated} t={t} />
  </main>;
}
