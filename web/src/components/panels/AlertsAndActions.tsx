import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Copy,
  FileText,
  Play,
  RotateCw,
  Sparkles,
  Square,
  Stethoscope,
  X,
} from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { api, copyToClipboard, localDateStr, lsGet, lsSet, quotaExpiringInfo } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

interface AlertsAndActionsProps {
  onStartBridge: () => void;
  onRestartBridge: () => void;
  onStopBridge: () => void;
  bridgeBusy: boolean;
}

interface AlertEntry {
  id: string;
  sev: number;
  tone: 'fail' | 'warn';
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  dismissible: boolean;
  onDismiss?: () => void;
}

export const AlertsAndActions: React.FC<AlertsAndActionsProps> = ({
  onStartBridge,
  onRestartBridge,
  onStopBridge,
  bridgeBusy,
}) => {
  const {
    overview,
    checkin,
    actionMsg,
    setMsg,
    loadDiag,
    loadOverview,
    loadCheckin,
    loadCheckinAccounts,
    loadPluginLogin,
    loadAccounts,
    loadModels,
    setActiveTab,
    setReqFailOnly,
    advanceFailWatermark,
    countNewFailures,
    buildDiagReport,
  } = useConsole();
  const { en, t } = useI18n();

  const [tokenMuted, setTokenMuted] = useState(() => lsGet('wb.muted.token') === '1');
  const [checkinMutedDate, setCheckinMutedDate] = useState(() => lsGet('wb.muted.checkin'));
  const [nextStepMuted, setNextStepMuted] = useState(() => lsGet('wb.muted.nextStep') === '1');
  const [quotaMutedTick, setQuotaMutedTick] = useState(0);
  const [exitingAlerts, setExitingAlerts] = useState<Set<string>>(new Set());
  const [exitingNextStep, setExitingNextStep] = useState(false);

  const dismissAlertSmooth = (id: string, cb?: () => void) => {
    setExitingAlerts((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      cb?.();
      setExitingAlerts((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 235);
  };

  const dismissNextStepSmooth = () => {
    setExitingNextStep(true);
    window.setTimeout(() => {
      lsSet('wb.muted.nextStep', '1');
      setNextStepMuted(true);
      setExitingNextStep(false);
    }, 235);
  };

  const b = overview?.bridge;
  const activeCred = overview?.credentials?.active;
  const newFails = countNewFailures();

  const alerts = useMemo<AlertEntry[]>(() => {
    void quotaMutedTick;
    if (!overview) return [];
    const list: AlertEntry[] = [];

    // 1. Bridge unavailable (sev 0, non-dismissible)
    if (!b || !b.running || !b.ok) {
      list.push({
        id: 'bridge-down',
        sev: 0,
        tone: 'fail',
        text: !b?.running
          ? t('本地 API 桥未运行，客户端与对话测试暂不可用。', 'Local API bridge is not running; client calls and chat tests are unavailable.')
          : t(`桥服务异常：${b.error || '健康检查未通过'}`, `Bridge unhealthy: ${b.error || 'health check failed'}`),
        actionLabel: t('启动桥服务', 'Start bridge'),
        onAction: onStartBridge,
        dismissible: false,
      });
    }

    // 2. Token expiring <= 3 days (sev 1, dismissible)
    const expMs = b?.auth?.expiresAt
      ? Date.parse(b.auth.expiresAt)
      : activeCred?.expiresAt
        ? Number(activeCred.expiresAt)
        : activeCred?.remainingMs != null
          ? Date.now() + activeCred.remainingMs
          : NaN;
    const remainMs = Number.isFinite(expMs) ? expMs - Date.now() : NaN;
    if (Number.isFinite(remainMs) && remainMs <= 3 * 86_400_000 && !tokenMuted) {
      const liveSource = b?.auth?.source || b?.credentialSource || 'desktop';
      const expired = remainMs <= 0;
      const msg = expired
        ? t('当前登录令牌已过期，请重新登录以恢复调用。', 'The active sign-in token has expired; sign in again to resume.')
        : liveSource === 'plugin'
          ? t('插件登录令牌将于 3 天内到期，建议重新在浏览器授权。', 'Plugin sign-in token expires within 3 days; re-authorize in browser.')
          : t('桌面端登录令牌将于 3 天内到期，过期后请打开 WorkBuddy 刷新登录。', 'Desktop sign-in token expires within 3 days; open WorkBuddy to refresh.');
      list.push({
        id: 'token-expiry',
        sev: 1,
        tone: expired ? 'fail' : 'warn',
        text: msg,
        actionLabel: t('重新诊断', 'Re-run diagnostics'),
        onAction: () => void loadDiag(),
        dismissible: true,
        onDismiss: () => {
          lsSet('wb.muted.token', '1');
          setTokenMuted(true);
        },
      });
    }

    // 3. Stale running bridge build (sev 1, non-dismissible)
    if (b?.running && b.staleBuild) {
      list.push({
        id: 'stale-build',
        sev: 1,
        tone: 'warn',
        text: t(
          '正在运行的桥还是旧构建（升级后旧进程仍在服务）。重启桥后新逻辑才会生效。',
          'The running bridge is still on an older build. Restart it to load the new logic.',
        ),
        actionLabel: t('重启桥', 'Restart bridge'),
        onAction: onRestartBridge,
        dismissible: false,
      });
    }

    // 4. Quota credits expiring <= 7 days (sev 1/2, dismissible per account & signature)
    const quotaInfo = quotaExpiringInfo(overview.quota);
    if (quotaInfo) {
      const acctKey = overview.quota?.account || activeCred?.account || 'default';
      const muteKey = `wb.muted.quotaExpiry:${acctKey}`;
      if (lsGet(muteKey) !== quotaInfo.signature) {
        const whenStr =
          quotaInfo.days === 0
            ? t('今天', 'today')
            : quotaInfo.days === 1
              ? t('明天', 'tomorrow')
              : t(`${quotaInfo.days} 天后`, `in ${quotaInfo.days} days`);
        list.push({
          id: 'quota-expiry',
          sev: quotaInfo.days <= 1 ? 1 : 2,
          tone: 'warn',
          text: en
            ? `${quotaInfo.remain} credits expire ${whenStr} (${quotaInfo.dateStr}).`
            : `有 ${quotaInfo.remain} 积分将在 ${whenStr}到期（${quotaInfo.dateStr}）。`,
          actionLabel: t('查看积分', 'View credits'),
          onAction: () => {
            setActiveTab('overview');
            window.scrollTo({ top: 0 });
          },
          dismissible: true,
          onDismiss: () => {
            lsSet(muteKey, quotaInfo.signature);
            setQuotaMutedTick((n) => n + 1);
          },
        });
      }
    }

    // 5. Bridge account != desktop login file (sev 2, non-dismissible)
    if (b?.auth?.userId && activeCred?.userId && b.auth.userId !== activeCred.userId) {
      const srcLabel = b.auth.source === 'plugin' ? t('插件登录', 'plugin sign-in') : t('桌面端快照', 'desktop snapshot');
      list.push({
        id: 'acct-mismatch',
        sev: 2,
        tone: 'warn',
        text: en
          ? `Bridge uses uid ${b.auth.userId.slice(0, 8)}… (${srcLabel}), different from desktop file uid ${activeCred.userId.slice(0, 8)}….`
          : `桥当前使用 uid ${b.auth.userId.slice(0, 8)}…（${srcLabel}），与桌面端登录文件 uid ${activeCred.userId.slice(0, 8)}… 不一致。`,
        actionLabel: t('改用桌面端', 'Use desktop session'),
        onAction: async () => {
          const r = await api<{ ok?: boolean; error?: string }>('/api/login/source', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'desktop' }),
          });
          if (r.ok) {
            setMsg(t('凭据来源已切换。', 'Credential source switched.'), 'good');
            await Promise.all([loadPluginLogin(), loadAccounts(), loadModels(), loadOverview()]);
          } else {
            setMsg(t('切换失败：', 'Switch failed: ') + (r.error || ''), 'err');
          }
        },
        dismissible: false,
      });
    }

    // 6. New failures (sev 2, dismissible)
    if (newFails > 0) {
      list.push({
        id: 'new-failures',
        sev: 2,
        tone: 'warn',
        text: en
          ? `${newFails} new failed request(s) in Recent Requests.`
          : `最近请求里有 ${newFails} 条新的失败。`,
        actionLabel: t('仅看失败', 'Failures only'),
        onAction: () => {
          setReqFailOnly(true);
          advanceFailWatermark();
          setActiveTab('overview');
          setTimeout(() => document.getElementById('reqBox')?.scrollIntoView({ block: 'start' }), 100);
        },
        dismissible: true,
        onDismiss: () => advanceFailWatermark(),
      });
    }

    // 7. Not checked in today (sev 3, dismissible for today)
    const today = localDateStr();
    if (checkin?.status?.active && !checkin.status.todayCheckedIn && checkinMutedDate !== today) {
      const errNote =
        checkin.checkin?.lastResult === 'error' && checkin.checkin.lastError
          ? en
            ? ` (last auto check-in failed: ${checkin.checkin.lastError})`
            : `（上次自动签到失败：${checkin.checkin.lastError}）`
          : '';
      list.push({
        id: 'daily-checkin',
        sev: 3,
        tone: 'warn',
        text: t('今天还没签到，签到积分过期不补。', 'Not checked in today yet — check-in credit expires and is not made up.') + errNote,
        actionLabel: t('立即签到', 'Check in now'),
        onAction: async () => {
          const r = await api<{ ok?: boolean; already?: boolean; credit?: number; error?: string }>('/api/checkin', { method: 'POST' });
          if (r.ok) {
            setMsg(
              r.already
                ? t('今天已经签过了。', 'Already checked in today.')
                : t(`签到成功${r.credit ? `（+${r.credit} 积分）` : ''}`, `Checked in${r.credit ? ` (+${r.credit} credits)` : ''}`),
              'good',
            );
            await Promise.all([loadCheckin(), loadCheckinAccounts(), loadOverview()]);
          } else {
            setMsg(t('签到失败：', 'Check-in failed: ') + (r.error || ''), 'err');
          }
        },
        dismissible: true,
        onDismiss: () => {
          lsSet('wb.muted.checkin', today);
          setCheckinMutedDate(today);
        },
      });
    }

    list.sort((x, y) => x.sev - y.sev);
    return list;
  }, [
    activeCred,
    advanceFailWatermark,
    b,
    checkin,
    checkinMutedDate,
    en,
    loadAccounts,
    loadCheckin,
    loadCheckinAccounts,
    loadDiag,
    loadModels,
    loadOverview,
    loadPluginLogin,
    newFails,
    onRestartBridge,
    onStartBridge,
    overview,
    quotaMutedTick,
    setActiveTab,
    setMsg,
    setReqFailOnly,
    t,
    tokenMuted,
  ]);

  const showNextStep = Boolean(b?.running && !overview?.dsh?.routeLive && !nextStepMuted);

  const handleCopyUrl = async () => {
    if (!b?.running || !b.endpoint) {
      setMsg(t('桥未运行，无法复制地址。', 'Bridge is not running; URL unavailable.'), 'err');
      return;
    }
    const url = b.endpoint.replace(/\/v1\/?$/, '') + '/v1';
    const ok = await copyToClipboard(url);
    setMsg(ok ? t(`已复制：${url}`, `Copied: ${url}`) : t('复制失败', 'Copy failed'), ok ? 'good' : 'err', url);
  };

  const handleCopyDiag = async () => {
    const md = buildDiagReport();
    const ok = await copyToClipboard(md);
    setMsg(
      ok
        ? t('诊断报告已复制到剪贴板（不含任何令牌值）', 'Diagnostics report copied (contains no tokens)')
        : t('复制失败', 'Copy failed'),
      ok ? 'good' : 'err',
    );
  };

  return (
    <div className="space-y-3">
      {/* Elevated Notification Stack */}
      <div id="alertBar" hidden={alerts.length === 0} className="space-y-2">
        {alerts.map((al) => {
          const isFail = al.tone === 'fail';
          const isExiting = exitingAlerts.has(al.id);
          return (
            <div
              key={al.id}
              role="alert"
              className={`flex flex-wrap items-center justify-between gap-3 rounded-[14px] px-3.5 py-2.5 text-[13px] ${
                isExiting ? 'wb-alert-exit' : 'wb-animate-in'
              }`}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-card), var(--specular)',
              }}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: isFail ? 'var(--fail-soft)' : 'var(--warn-soft)',
                    color: isFail ? 'var(--fail-dot)' : 'var(--warn-dot)',
                  }}
                >
                  {isFail ? <AlertCircle className="h-[15px] w-[15px]" /> : <AlertTriangle className="h-[15px] w-[15px]" />}
                </span>
                <span className="font-medium leading-snug" style={{ color: 'var(--text)' }}>{al.text}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {al.actionLabel && al.onAction && (
                  <button
                    type="button"
                    onClick={al.onAction}
                    className="wb-btn wb-btn-sm rounded-full px-3"
                  >
                    {al.actionLabel}
                  </button>
                )}
                {al.dismissible && al.onDismiss && (
                  <button
                    type="button"
                    onClick={() => dismissAlertSmooth(al.id, al.onDismiss)}
                    className="wb-btn wb-btn-ghost wb-btn-sm rounded-full px-2.5"
                    style={{ color: 'var(--muted)' }}
                  >
                    {t('知道了', 'Got it')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* NextStep Onboarding Strip */}
      <div id="nextStepBar" hidden={!showNextStep}>
        {showNextStep && (
          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-[14px] px-3.5 py-2.5 text-[13px] ${
              exitingNextStep ? 'wb-alert-exit' : 'wb-animate-in'
            }`}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-card), var(--specular)',
            }}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
              >
                <Sparkles className="h-[15px] w-[15px]" />
              </span>
              <span className="font-medium leading-snug" style={{ color: 'var(--text)' }}>
                {t(
                  '桥已就绪。下一步：一键接入 Codex / Claude Code / opencode，或在「可用模型」中配置客户端默认模型范围。',
                  'Bridge is ready. Next step: connect Codex / Claude Code / opencode in one click, or configure the default model list in Available Models.',
                )}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveTab('clients')}
                className="wb-btn wb-btn-accent wb-btn-sm rounded-full px-3"
              >
                {t('去接客户端', 'Connect a client')}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={dismissNextStepSmooth}
                aria-label={t('知道了', 'Got it')}
                className="wb-btn wb-btn-ghost wb-btn-sm rounded-full px-2.5"
                style={{ color: 'var(--muted)' }}
              >
                <X className="h-3.5 w-3.5" />
                {t('知道了', 'Got it')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sleek Contextual Action Strip */}
      <div className="wb-inset px-3 py-2 flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            id="startBtn"
            disabled={bridgeBusy || b?.ok === true}
            onClick={onStartBridge}
            className="wb-btn wb-btn-primary wb-btn-sm"
          >
            <Play className="h-3.5 w-3.5" />
            {t('启动桥服务', 'Start bridge')}
          </button>
          <button
            type="button"
            id="restartBtn"
            disabled={bridgeBusy}
            onClick={onRestartBridge}
            className="wb-btn wb-btn-sm"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t('重启桥', 'Restart bridge')}
          </button>
          <button
            type="button"
            id="stopBtn"
            disabled={bridgeBusy || !b?.running}
            onClick={onStopBridge}
            className="wb-btn wb-btn-danger wb-btn-sm"
          >
            <Square className="h-3.5 w-3.5" />
            {t('停止', 'Stop')}
          </button>
        </div>

        <span className="hidden sm:inline-block h-4 w-px mx-1" style={{ background: 'var(--border)' }} />

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            id="diagBtn"
            onClick={() => void loadDiag()}
            className="wb-btn wb-btn-ghost wb-btn-sm"
          >
            <Stethoscope className="h-3.5 w-3.5" />
            {t('重新诊断', 'Re-run diagnostics')}
          </button>
          <button
            type="button"
            id="copyUrlBtn"
            onClick={() => void handleCopyUrl()}
            className="wb-btn wb-btn-ghost wb-btn-sm"
          >
            <Copy className="h-3.5 w-3.5" />
            {t('复制地址', 'Copy URL')}
          </button>
          <button
            type="button"
            id="copyDiagBtn"
            onClick={() => void handleCopyDiag()}
            className="wb-btn wb-btn-ghost wb-btn-sm"
          >
            <FileText className="h-3.5 w-3.5" />
            {t('复制诊断报告', 'Copy diagnostics report')}
          </button>
        </div>

        <div className="flex-1" />

        <span
          id="actionMsg"
          title={actionMsg.title || actionMsg.text}
          className="text-[12px] font-medium truncate max-w-full sm:max-w-[340px]"
          style={{
            color:
              actionMsg.tone === 'good'
                ? 'var(--ok)'
                : actionMsg.tone === 'err'
                  ? 'var(--fail)'
                  : 'var(--muted)',
          }}
        >
          {actionMsg.text}
        </span>
      </div>
    </div>
  );
};
