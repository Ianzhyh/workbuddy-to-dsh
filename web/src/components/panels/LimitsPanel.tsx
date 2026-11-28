import React, { useEffect, useState } from 'react';
import { Gauge, RefreshCw, ShieldAlert } from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { fmtCountdown } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { LimitItem } from '../../types/api';
import { EmptyState, Panel, SkeletonBlock } from '../ui/Panel';

export const LimitsPanel: React.FC = () => {
  const { limits, limitsError, limitsStamp, loadLimits, setMsg } = useConsole();
  const { en, t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const rawItems = limits?.limiting || [];
  const hasTimed = rawItems.some((it) => {
    if (!it.resetAt || it.kind === 'credits' || it.kind === 'account_restricted') return false;
    const ms = Date.parse(it.resetAt);
    return Number.isFinite(ms) && ms > now;
  });

  // 1-second local countdown tick only when active timed items exist
  useEffect(() => {
    if (!hasTimed) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [hasTimed]);

  // Filter out expired entries locally every tick
  const activeItems = rawItems.filter((it) => {
    if (!it.resetAt || it.kind === 'credits' || it.kind === 'account_restricted') return true;
    const ms = Date.parse(it.resetAt);
    return !Number.isFinite(ms) || ms > now;
  });

  // Group by account UID
  const groups = new Map<string, { uid: string; label: string; isCurrent: boolean; severe: boolean; items: LimitItem[] }>();
  for (const it of activeItems) {
    const uid = it.uid || '(unknown)';
    const g = groups.get(uid) || {
      uid,
      label: it.accountLabel || uid.slice(0, 8),
      isCurrent: false,
      severe: false,
      items: [],
    };
    if (it.isCurrent) g.isCurrent = true;
    if (it.kind === 'credits' || it.kind === 'account_restricted') g.severe = true;
    g.items.push(it);
    groups.set(uid, g);
  }
  const groupList = [...groups.values()];

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadLimits({ refresh: true });
      setMsg(t('已刷新用量上限', 'Usage limits refreshed'), 'good');
    } finally {
      setRefreshing(false);
    }
  };

  const renderKindMeta = (it: LimitItem) => {
    if (it.kind === 'credits') {
      return {
        tagClass: 'wb-tag-fail',
        tagText: t('积分不足', 'Not enough credits'),
        advice: t('充积分或换号，等待无效', 'Top up or switch account; waiting will not help'),
        statusText: t('需充值，不会自动恢复', 'Top up — this will not recover by itself'),
      };
    }
    if (it.kind === 'account_restricted') {
      return {
        tagClass: 'wb-tag-fail',
        tagText: t('账号被风控', 'Account flagged'),
        advice: t('重新登录无效，请换号', 'Re-login will not help; switch account'),
        statusText: t('换号（重新登录无效）', 'Switch account — re-login will not help'),
      };
    }
    if (it.kind === 'rate_limit') {
      const resetMs = it.resetAt ? Date.parse(it.resetAt) : NaN;
      return {
        tagClass: 'wb-tag-warn',
        tagText: t('触发了限流', 'Rate limited'),
        advice: t('稍等再试', 'Wait and retry'),
        statusText: Number.isFinite(resetMs)
          ? `${t('还剩 ', 'Resets in ')}${fmtCountdown(resetMs - now, en)}`
          : t('10 分钟窗口内', 'within the 10-minute window'),
      };
    }
    // default: quota
    const resetMs = it.resetAt ? Date.parse(it.resetAt) : NaN;
    return {
      tagClass: 'wb-tag-warn',
      tagText: t('额度已用尽', 'Quota exhausted'),
      advice: t('换模型或换号', 'Switch model or account'),
      statusText: Number.isFinite(resetMs)
        ? `${t('还剩 ', 'Resets in ')}${fmtCountdown(resetMs - now, en)}`
        : t('上游未给恢复时间', 'Upstream gave no reset time'),
    };
  };

  return (
    <Panel
      section="overview"
      title={t('用量上限', 'Usage limits')}
      subtitle={t('哪个账号的哪个模型触顶了（不只看当前账号）', 'Which account hit its limit, and on which model (cross-account)')}
      icon={<Gauge className="h-4 w-4" />}
      stamp={limitsStamp ? t(`更新于 ${limitsStamp}`, `Updated ${limitsStamp}`) : undefined}
      stampId="limitsStamp"
      actions={
        <button
          type="button"
          id="limitsRefreshBtn"
          disabled={refreshing}
          onClick={() => void handleRefresh()}
          className="wb-btn wb-btn-sm"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {t('刷新上限', 'Refresh limits')}
        </button>
      }
    >
      <div id="limitsBox">
        {!limits && !limitsError ? (
          <SkeletonBlock lines={2} />
        ) : limitsError ? (
          <div
            className="rounded-xl px-4 py-3 text-[12.5px]"
            style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}
          >
            {limitsError}
          </div>
        ) : groupList.length === 0 ? (
          <EmptyState
            icon={<Gauge className="h-5 w-5" />}
            title={
              (limits?.expiredCount || 0) > 0
                ? t('额度已恢复（刚到期移除）。', 'Limits cleared (just expired and removed).')
                : t('没有账号触顶（最近 10 分钟）。', 'No account is limited (last 10 minutes).')
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
              {(limits?.accountCount || groupList.length) > 1
                ? en
                  ? `All accounts are listed, not just the active one (${limits?.accountCount || groupList.length} accounts). Each entry disappears when its reset time arrives.`
                  : `所有账号都已列出，不只当前这个（共 ${limits?.accountCount || groupList.length} 个账号）。每条到恢复时间会自动消失。`
                : t('到恢复时间会自动消失；换模型或换号可恢复。', 'Each entry disappears when its reset time arrives; switching model or account recovers immediately.')}
            </div>
            <div className="grid grid-cols-1 gap-3">
              {groupList.map((g) => (
                <div
                  key={g.uid}
                  className={`rounded-xl p-3.5 ${g.severe ? 'acct-limited' : ''}`}
                  style={{
                    background: g.severe ? 'var(--fail-soft)' : 'var(--surface-subtle)',
                    border: `1px solid ${g.severe ? 'var(--fail-border)' : 'var(--border)'}`,
                  }}
                >
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {g.severe && <ShieldAlert className="h-4 w-4 shrink-0" style={{ color: 'var(--fail)' }} />}
                      <span className="font-semibold text-[13.5px] truncate" data-i18n-skip="" style={{ color: 'var(--text)' }}>
                        {g.label}
                      </span>
                      {g.isCurrent && <span className="wb-tag wb-tag-ok">{t('当前', 'Current')}</span>}
                    </div>
                    <span className="wb-tag">{g.items.length} {t('条', 'rows')}</span>
                  </div>
                  <div className="space-y-2">
                    {g.items.map((it, i) => {
                      const meta = renderKindMeta(it);
                      return (
                        <div
                          key={`${it.model}-${it.kind}-${i}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12.5px]"
                          style={{ background: 'var(--surface)', border: '1px solid var(--border-subtle)' }}
                        >
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <code className="font-semibold text-[12px]" style={{ color: 'var(--text)' }}>
                              {it.model || '—'}
                            </code>
                            <span className={`wb-tag ${meta.tagClass}`}>{meta.tagText}</span>
                            <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                              {meta.advice}
                            </span>
                          </div>
                          <span
                            className="text-[12px] font-semibold"
                            style={{ color: it.kind === 'credits' || it.kind === 'account_restricted' ? 'var(--fail)' : 'var(--warn)' }}
                          >
                            {meta.statusText}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
};
