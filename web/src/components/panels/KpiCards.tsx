import React from 'react';
import {
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  Globe,
  Lock,
  Server,
  User,
} from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { fmtDateTime, fmtDuration, fmtUptime } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

export const KpiCards: React.FC = () => {
  const { overview, models } = useConsole();
  const { en, t, tu } = useI18n();

  if (!overview) {
    return (
      <div id="cards" data-section="overview" className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="wb-kpi p-5 space-y-3">
              <div className="wb-skeleton h-3 w-24" />
              <div className="wb-skeleton h-7 w-32" />
              <div className="wb-skeleton h-2 w-full rounded-full" />
              <div className="wb-skeleton h-3 w-44" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="wb-kpi p-3.5 space-y-2.5">
              <div className="wb-skeleton h-3 w-16" />
              <div className="wb-skeleton h-5 w-24" />
              <div className="wb-skeleton h-2.5 w-32" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const b = overview.bridge;
  const a = overview.credentials?.active;
  const q = overview.quota;
  const dsh = overview.dsh;
  const mList = models?.models ?? null;

  // 1. Bridge runtime
  const bridgeVal = b?.uptimeMs != null
    ? `${t('运行', 'Up')} ${fmtUptime(b.uptimeMs, en)}`
    : b?.running
      ? '—'
      : t('未运行', 'Stopped');
  const bridgeNote = b?.pid
    ? `PID ${b.pid}${b.catalogSize != null ? ` · ${t(`目录 ${b.catalogSize} 模型`, `${b.catalogSize} models`)}` : ''}`
    : b?.running
      ? t('该桥未汇报进程信息（版本较旧）', 'Older bridge version (no process metadata)')
      : b?.endpoint || '127.0.0.1:8790';

  // 2. Credit balance & package utilization
  const unlimited = q?.unlimited === true || (q && Number(q.total) < 0);
  const quotaVal = q ? (unlimited ? '∞' : Number(q.total).toLocaleString()) : '—';
  const pkgs = q?.packages || [];
  const totalPackSize = pkgs.reduce((s, p) => s + (Number(p.size) || 0), 0);
  const totalPackRemain = pkgs.reduce((s, p) => s + (Number(p.remain) || 0), 0);
  const packPct = unlimited
    ? 100
    : totalPackSize > 0
      ? Math.max(0, Math.min(100, Math.round((totalPackRemain / totalPackSize) * 100)))
      : q && Number(q.total) > 0
        ? 100
        : 0;
  const quotaNote = !q
    ? t('桥未运行或查询失败', 'Bridge stopped or query failed')
    : unlimited
      ? t('不限量权益', 'Unlimited plan')
      : pkgs.length
        ? `${pkgs.slice(0, 2).map((p) => `${tu(p.name)} ${p.remain}/${p.size}`).join(' · ')}${pkgs.length > 2 ? t(` +${pkgs.length - 2}`, ` +${pkgs.length - 2}`) : ''}`
        : t('无套餐', 'No packages');

  // 3. Token TTL & health bar
  const expMs = b?.auth?.expiresAt
    ? Date.parse(b.auth.expiresAt)
    : a?.expiresAt
      ? Number(a.expiresAt)
      : a?.remainingMs != null
        ? Date.now() + a.remainingMs
        : NaN;
  const tokenRemain = Number.isFinite(expMs) ? expMs - Date.now() : NaN;
  const tokenHealthColor = !Number.isFinite(tokenRemain)
    ? 'var(--faint)'
    : tokenRemain < 7 * 86_400_000
      ? 'var(--fail-dot)'
      : tokenRemain < 30 * 86_400_000
        ? 'var(--warn-dot)'
        : 'var(--ok-dot)';
  const tokenPct = Number.isFinite(tokenRemain)
    ? Math.max(4, Math.min(100, Math.round((tokenRemain / (60 * 86_400_000)) * 100)))
    : 0;
  const srcLabel = (b?.auth?.source || b?.credentialSource) === 'plugin'
    ? t('插件凭据', 'plugin')
    : t('桌面端凭据', 'desktop');
  const tokenNote = Number.isFinite(expMs)
    ? `${t('至', 'Until')} ${fmtDateTime(expMs)} · ${srcLabel}`
    : t('无有效凭据', 'No active credential');

  // 4. Models
  const modelsVal = mList ? String(mList.length) : b?.catalogSize != null ? String(b.catalogSize) : '—';
  const modelsNote = mList === null
    ? models?.error
      ? t(`目录读取失败：${models.error}`, `Catalog error: ${models.error}`)
      : t('正在读取模型目录…', 'Loading catalog…')
    : mList.length
      ? `${mList.slice(0, 2).map((m) => m.id).join(' · ')}${mList.length > 2 ? ` +${mList.length - 2}` : ''}`
      : t('目录为空', 'Catalog empty');

  // 5. Account
  const bridgeUid = b?.auth?.userId || '';
  const acctVal = bridgeUid
    ? bridgeUid === a?.userId
      ? a?.alias || a?.account || `uid ${bridgeUid.slice(0, 8)}…`
      : `uid ${bridgeUid.slice(0, 8)}…`
    : a?.alias || a?.account || '—';
  const mismatch = Boolean(bridgeUid && a?.userId && bridgeUid !== a.userId);
  const acctNote = mismatch
    ? t(`桌面文件 ${a?.userId?.slice(0, 8)}… 未生效`, `Desktop ${a?.userId?.slice(0, 8)}… inactive`)
    : [a?.account, a?.userId ? `uid ${a.userId.slice(0, 8)}…` : '', srcLabel].filter(Boolean).join(' · ') || '—';

  // 6. DSH config
  const nativeRoute = dsh?.routeMode === 'native' || dsh?.nativeRoute === true;
  const credOk = Boolean(dsh?.hasBridgeKey || nativeRoute);
  const cfgOk = Boolean(dsh?.routeLive && credOk);
  const dshVal = cfgOk ? (dsh?.bundlesOk ? t('已就绪', 'Ready') : t('待修复', 'Needs fix')) : t('未就绪', 'Not ready');
  const dshNote = [
    `${t('路由', 'Route')} ${dsh?.routeLive ? '✓' : '✗'}`,
    nativeRoute ? `${t('原生', 'Native')} ✓` : `${t('凭据', 'Key')} ${dsh?.hasBridgeKey ? '✓' : '✗'}`,
    `bundle ${dsh?.bundlesOk ? '✓' : '✗'}`,
  ].join(' · ');

  // 7. Encryption
  const encVal = a ? (a.encrypted ? t('AtRest 信封', 'AtRest Envelope') : t('明文', 'Plaintext')) : '—';
  const encNote = a
    ? a.keyIdMatches
      ? `keyId ${a.keyId || 'ok'}`
      : t('keyId 不匹配', 'keyId mismatch')
    : t('未读取到登录文件', 'No login file');

  // 8. Upstream endpoint
  const upVal = b?.upstream ? b.upstream.replace(/^https?:\/\//, '') : '—';
  const cleanEndpoint = b?.endpoint
    ? b.endpoint.replace(/\/v1\/?$/, '') + '/v1'
    : 'http://127.0.0.1:8790/v1';
  const upNote = `${t('本地', 'Local')} ${cleanEndpoint}`;

  const compactTiles = [
    {
      label: t('可用模型', 'Available models'),
      value: modelsVal,
      note: modelsNote,
      icon: <Cpu className="h-3.5 w-3.5" />,
      dot: mList && mList.length > 0 ? 'var(--primary)' : 'var(--faint)',
      mono: false,
    },
    {
      label: t('当前账号', 'Account'),
      value: acctVal,
      note: acctNote,
      icon: <User className="h-3.5 w-3.5" />,
      dot: mismatch ? 'var(--warn-dot)' : 'var(--ok-dot)',
      mono: true,
      skipI18n: true,
    },
    {
      label: t('DSH 配置', 'DSH config'),
      value: dshVal,
      note: dshNote,
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      dot: cfgOk ? 'var(--ok-dot)' : 'var(--faint)',
      mono: false,
    },
    {
      label: t('凭据加密', 'Encryption'),
      value: encVal,
      note: encNote,
      icon: <Lock className="h-3.5 w-3.5" />,
      dot: a?.encrypted ? 'var(--ok-dot)' : 'var(--warn-dot)',
      mono: false,
    },
    {
      label: t('上游端点', 'Upstream'),
      value: upVal,
      note: upNote,
      icon: <Globe className="h-3.5 w-3.5" />,
      dot: b?.upstream ? 'var(--info-dot)' : 'var(--faint)',
      mono: true,
    },
  ];

  return (
    <div id="cards" data-section="overview" className="space-y-3">
      {/* Row 1: 3 Spacious Hero Telemetry Bento Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* Hero 1: Bridge Process */}
        <div
          className="wb-kpi wb-animate-in p-4.5 sm:p-5 flex flex-col justify-between min-w-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
              <Server className="h-3.5 w-3.5" style={{ color: 'var(--faint)' }} />
              {t('桥进程', 'Bridge process')}
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
              style={
                b?.ok
                  ? { background: 'var(--ok-soft)', color: 'var(--ok)', border: '1px solid var(--ok-border)' }
                  : { background: 'var(--fail-soft)', color: 'var(--fail)', border: '1px solid var(--fail-border)' }
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${b?.ok ? 'wb-dot-pulse' : ''}`}
                style={{ background: b?.ok ? 'var(--ok-dot)' : 'var(--fail-dot)' }}
              />
              {b?.ok ? t('在线', 'Live') : b?.running ? t('异常', 'Degraded') : t('离线', 'Offline')}
            </span>
          </div>
          <div className="mt-3 text-[24px] font-bold tracking-[-0.025em] leading-none truncate" style={{ color: 'var(--text)' }} title={bridgeVal}>
            {bridgeVal}
          </div>
          <div className="mt-3.5 pt-2.5 flex items-center justify-between gap-2 text-[11.5px]" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--muted)' }}>
            <span className="truncate" title={bridgeNote}>{bridgeNote}</span>
            {b?.port && (
              <span className="mono shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
                :{b.port}
              </span>
            )}
          </div>
        </div>

        {/* Hero 2: Credit Balance */}
        <div
          className="wb-kpi wb-animate-in p-4.5 sm:p-5 flex flex-col justify-between min-w-0"
          style={{ animationDelay: '40ms' }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
              <Coins className="h-3.5 w-3.5" style={{ color: 'var(--faint)' }} />
              {t('积分余额', 'Credit balance')}
            </span>
            {q && !unlimited && totalPackSize > 0 && (
              <span className="mono text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                {packPct}%
              </span>
            )}
          </div>
          <div className="mt-3 flex items-baseline gap-2 min-w-0">
            <span className="text-[24px] font-bold tracking-[-0.025em] leading-none truncate" style={{ color: 'var(--text)' }} title={quotaVal}>
              {quotaVal}
            </span>
            {q && !unlimited && (
              <span className="text-[11.5px] font-medium shrink-0" style={{ color: 'var(--faint)' }}>
                {t('剩余积分', 'credits')}
              </span>
            )}
          </div>
          <div className="mt-3 space-y-2">
            <div className="h-[4px] w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-muted)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${packPct}%`,
                  background: packPct < 15 ? 'var(--fail-dot)' : packPct < 35 ? 'var(--warn-dot)' : 'var(--primary)',
                }}
              />
            </div>
            <div className="text-[11.5px] truncate" style={{ color: 'var(--muted)' }} title={quotaNote}>
              {quotaNote}
            </div>
          </div>
        </div>

        {/* Hero 3: Token TTL */}
        <div
          className="wb-kpi wb-animate-in p-4.5 sm:p-5 flex flex-col justify-between min-w-0"
          style={{ animationDelay: '80ms' }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
              <Clock className="h-3.5 w-3.5" style={{ color: 'var(--faint)' }} />
              {t('令牌剩余', 'Token TTL')}
            </span>
            <span className="mono text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--faint)' }}>
              {srcLabel}
            </span>
          </div>
          <div className="mt-3 text-[24px] font-bold tracking-[-0.025em] leading-none truncate" style={{ color: 'var(--text)' }}>
            {Number.isFinite(tokenRemain) ? fmtDuration(tokenRemain, en) : '—'}
          </div>
          <div className="mt-3 space-y-2">
            <div className="h-[4px] w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-muted)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${tokenPct}%`, background: tokenHealthColor }}
              />
            </div>
            <div className="text-[11.5px] truncate" style={{ color: 'var(--muted)' }} title={tokenNote}>
              {tokenNote}
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: 5 Precision Telemetry Strip Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        {compactTiles.map((item, idx) => (
          <div
            key={item.label}
            className="wb-kpi wb-animate-in px-4 py-3.5 flex flex-col justify-between min-w-0"
            style={{ animationDelay: `${110 + idx * 30}ms` }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium truncate" style={{ color: 'var(--muted)' }}>
                <span style={{ color: 'var(--faint)' }}>{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </span>
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: item.dot }} />
            </div>
            <div
              className={`mt-2 font-semibold tracking-tight truncate ${item.mono ? 'mono text-[13.5px]' : 'text-[16px]'}`}
              data-i18n-skip={'skipI18n' in item && item.skipI18n ? '' : undefined}
              style={{ color: 'var(--text)' }}
              title={item.value}
            >
              {item.value}
            </div>
            <div className="mt-1 text-[11px] truncate" style={{ color: 'var(--faint)' }} title={item.note}>
              {item.note}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
