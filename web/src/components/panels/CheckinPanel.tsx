import React, { useState } from 'react';
import { CalendarCheck, CheckCircle2, ChevronRight, Gift, RefreshCw, Sparkles } from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { api, fmtDateTime, fmtDuration, fmtShortClock } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { CheckinAccountsResponse } from '../../types/api';
import { Collapse } from '../ui/Collapse';
import { Panel, SkeletonBlock } from '../ui/Panel';
import { Switch } from '../ui/Switch';

export const CheckinPanel: React.FC = () => {
  const {
    checkin,
    checkinStamp,
    checkinAccounts,
    checkinAccountsStamp,
    loadCheckin,
    loadCheckinAccounts,
    loadOverview,
    setMsg,
  } = useConsole();
  const { en, t } = useI18n();

  const [claimingOne, setClaimingOne] = useState(false);
  const [claimingAll, setClaimingAll] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [noActivityOpen, setNoActivityOpen] = useState(false);

  const handleDoCheckin = async () => {
    setClaimingOne(true);
    try {
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
    } finally {
      setClaimingOne(false);
    }
  };

  const handleToggleAuto = async (next: boolean) => {
    setAutoBusy(true);
    try {
      const r = await api<{ saved?: boolean; error?: string }>('/api/checkin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto: next }),
      });
      if (r.saved) {
        setMsg(
          next
            ? t('已开启每日自动签到（桥侧需重启桥生效）', 'Daily auto check-in enabled (restart bridge to apply)')
            : t('已关闭每日自动签到（桥侧需重启桥生效）', 'Daily auto check-in disabled (restart bridge to apply)'),
          'good',
        );
        await loadCheckin();
      } else {
        setMsg(t('保存失败：', 'Save failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setAutoBusy(false);
    }
  };

  const handleClaimAll = async () => {
    setClaimingAll(true);
    try {
      const r = await api<CheckinAccountsResponse>('/api/checkin/all', { method: 'POST', timeoutMs: 120_000 });
      if (r.ok) {
        const tot = r.totals || { accounts: 0, claimed: 0, already: 0, failed: 0, skipped: 0, credit: 0 };
        const parts: string[] = [];
        if (tot.claimed > 0) parts.push(t(`领取 ${tot.claimed} 个${tot.credit ? `（+${tot.credit} 积分）` : ''}`, `claimed ${tot.claimed}${tot.credit ? ` (+${tot.credit})` : ''}`));
        if (tot.already > 0) parts.push(t(`已签过 ${tot.already} 个`, `${tot.already} already`));
        if (tot.skipped > 0) parts.push(t(`无活动 ${tot.skipped} 个`, `${tot.skipped} skipped`));
        if (tot.failed > 0) parts.push(t(`失败 ${tot.failed} 个`, `${tot.failed} failed`));
        const summary = parts.length ? parts.join(' · ') : t('本机所有账号今天都已处理过', 'All accounts handled');
        setMsg(`${t('全部领取：', 'Claimed for all: ')}${summary}`, tot.failed > 0 ? 'err' : 'good');
        await Promise.all([loadCheckinAccounts(), loadCheckin(), loadOverview()]);
      } else {
        setMsg(t('全部领取失败：', 'Claim-for-all failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setClaimingAll(false);
    }
  };

  const cMeta = checkin?.checkin;
  const status = checkin?.status;
  const autoOn = cMeta?.auto !== false;

  const sourceLabel = (src?: string | null) => {
    if (src === 'manual') return t('手动', 'Manual');
    if (src === 'auto') return t('自动（桥的定时器）', 'Auto (bridge timer)');
    if (src === 'hourly') return t('自动（每小时检查）', 'Auto (hourly check)');
    if (src === 'startup') return t('自动（启动时）', 'Auto (on startup)');
    return src || '';
  };

  const resultLabel = (res?: string | null) => {
    if (res === 'ok') return t('成功', 'Success');
    if (res === 'already') return t('上游已签到（按成功处理）', 'Already checked in upstream');
    if (res === 'no-activity') return t('当前账号没有签到活动', 'No check-in program');
    if (res === 'error') return t('失败', 'Failed');
    return res || '';
  };

  // Multi-account calculations: denominator = active-program accounts ONLY!
  const allAcctRows = checkinAccounts?.accounts || [];
  const activeAcctRows = allAcctRows.filter((a) => !a.noActivity);
  const noActRows = allAcctRows.filter((a) => a.noActivity);
  const activeTotal = activeAcctRows.length;
  const signedCount = activeAcctRows.filter((a) => a.status?.todayCheckedIn).length;
  const totalTodayCredit = activeAcctRows.reduce(
    (sum, a) => sum + (a.status?.todayCheckedIn && (a.status?.todayCredit || 0) > 0 ? Number(a.status!.todayCredit) : 0),
    0,
  );
  const pct = activeTotal > 0 ? Math.round((signedCount / activeTotal) * 100) : 0;
  const canClaimAny = allAcctRows.some((a) => !a.expired && !a.noActivity && !a.status?.todayCheckedIn);

  return (
    <div data-section="overview" className="grid grid-cols-1 xl:grid-cols-12 gap-5">
      {/* Left 5 cols: Current Account Daily Check-in */}
      <Panel
        className="xl:col-span-5"
        title={t('每日签到', 'Daily check-in')}
        subtitle={t('当前账号签到状态与自动签到开关', 'Current account status & auto check-in setting')}
        icon={<Gift className="h-4 w-4" />}
        stamp={checkinStamp ? t(`更新于 ${checkinStamp}`, `Updated ${checkinStamp}`) : undefined}
        stampId="checkinStamp"
      >
        <div id="checkinBox" className="space-y-4">
          {!checkin ? (
            <SkeletonBlock lines={3} />
          ) : !status ? (
            <div className="rounded-xl px-3.5 py-3 text-[12.5px]" style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}>
              {t('读取失败：', 'Read failed: ')}{checkin.error || t('桥未运行', 'Bridge not running')}
            </div>
          ) : !status.active ? (
            <div className="rounded-xl px-3.5 py-3 text-[12.5px]" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
              {t('当前账号没有签到活动（国际版网关不含积分系统）。', 'This account has no check-in program (the international gateway has no credit system).')}
            </div>
          ) : (
            <div
              className="rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
              style={{
                background: status.todayCheckedIn ? 'var(--ok-soft)' : 'var(--warn-soft)',
                border: `1px solid ${status.todayCheckedIn ? 'var(--ok-border)' : 'var(--warn-border)'}`,
              }}
            >
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-bold" style={{ color: status.todayCheckedIn ? 'var(--ok)' : 'var(--warn)' }}>
                    {status.todayCheckedIn ? t('今日已签到', 'Checked in today') : t('今日尚未签到', 'Not checked in today')}
                  </span>
                  {status.todayCheckedIn && cMeta?.lastAt && (
                    <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                      · {cMeta.lastSource === 'manual' ? t('手动', 'Manual') : t('自动', 'Auto')} ({fmtShortClock(cMeta.lastAt)})
                    </span>
                  )}
                  <span className="wb-tag wb-tag-primary">
                    {(status.streakDays || 0) > 0
                      ? t(`连续 ${status.streakDays} 天`, `Streak ${status.streakDays}d`)
                      : t('尚未开始', 'Not started')}
                  </span>
                </div>
                <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  {status.dailyCredit != null && <span>{t(`每日 +${status.dailyCredit}`, `Daily +${status.dailyCredit}`)}</span>}
                  {status.streakBonusDays != null && status.streakBonusCredit != null && (
                    <span className="ml-2">
                      · {t(`连续 ${status.streakBonusDays} 天可得 ${status.streakBonusCredit} 积分`, `${status.streakBonusDays}d streak → +${status.streakBonusCredit}`)}
                    </span>
                  )}
                </div>
                {!status.todayCheckedIn && cMeta?.lastResult === 'error' && cMeta.lastError && (
                  <div className="text-[12px] font-medium" style={{ color: 'var(--fail)' }}>
                    {cMeta.lastError} {t('· 可手动重试', '· you can retry manually')}
                  </div>
                )}
              </div>
              {status.todayCheckedIn ? (
                <span className="wb-tag wb-tag-ok px-2.5 h-7 text-[12px]">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t('已领取', 'Claimed')}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={claimingOne}
                  onClick={() => void handleDoCheckin()}
                  className="wb-btn wb-btn-primary wb-btn-sm"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {claimingOne ? t('签到中…', 'Checking in…') : t('立即签到', 'Check in now')}
                </button>
              )}
            </div>
          )}

          {/* Auto Check-in Toggle Row (rendered in ALL 3 states) */}
          {checkin && (
            <div className="wb-inset p-3.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Switch
                  id="checkinAuto"
                  checked={autoOn}
                  disabled={autoBusy}
                  onChange={(next) => void handleToggleAuto(next)}
                  label={<span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>{t('每日自动签到', 'Daily auto check-in')}</span>}
                />
                <span className={`wb-tag ${autoOn ? 'wb-tag-ok' : ''}`}>
                  {autoOn ? t('已开启', 'On') : t('已关闭', 'Off')}
                </span>
              </div>
              <p className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                {t('由桥定时自动执行；切换后桥侧需重启桥生效（这里不自动重启）。', 'Executed automatically by bridge timer; restart bridge for bridge-side changes to take effect.')}
              </p>
              <div className="text-[11.5px] mono" style={{ color: 'var(--faint)' }}>
                {cMeta?.lastAt
                  ? `${t('上次尝试：', 'Last attempt: ')}${fmtDateTime(cMeta.lastAt)} · ${sourceLabel(cMeta.lastSource)} · ${resultLabel(cMeta.lastResult)}${cMeta.lastError ? ` (${cMeta.lastError})` : ''}`
                  : t('还没有自动尝试记录。', 'No automatic attempts recorded yet.')}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Right 7 cols: Per-Account Check-in */}
      <Panel
        className="xl:col-span-7"
        title={t('账号签到状态', 'Per-account check-in')}
        subtitle={t('本机各账号各领各的，不切换账号', 'Each local account claims its own without switching the active account')}
        icon={<CalendarCheck className="h-4 w-4" />}
        stamp={checkinAccountsStamp ? t(`更新于 ${checkinAccountsStamp}`, `Updated ${checkinAccountsStamp}`) : undefined}
        stampId="acctCheckinStamp"
      >
        <div id="acctCheckinBox" className="space-y-3">
          {!checkinAccounts ? (
            <SkeletonBlock lines={3} />
          ) : !checkinAccounts.ok ? (
            <div className="rounded-xl px-3.5 py-3 text-[12.5px]" style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}>
              {checkinAccounts.error || t('桥未运行', 'Bridge not running')}
            </div>
          ) : allAcctRows.length === 0 ? (
            <div className="text-[12.5px] py-3" style={{ color: 'var(--muted)' }}>
              {t('没有找到本机已登录的账号。', 'No signed-in local accounts found.')}
            </div>
          ) : (
            <>
              {/* Progress Bar + Claim All Header (denominator = active-program accounts ONLY) */}
              <div className="rounded-xl p-3 space-y-2.5" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[12.5px]">
                    {activeTotal > 0 ? (
                      <span className="font-semibold" style={{ color: 'var(--text)' }}>
                        {t(`今日已签 ${signedCount}/${activeTotal} 个有活动的账号`, `Checked in today ${signedCount}/${activeTotal} active accounts`)}
                        {totalTodayCredit > 0 && (
                          <span className="ml-2 font-medium" style={{ color: 'var(--ok)' }}>
                            · {t(`共领 +${totalTodayCredit} 分`, `total +${totalTodayCredit}`)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>
                        {t('本机账号都没有签到活动', 'No local account has a check-in program')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {activeTotal > 0 && (
                      <span className="mono text-[12px] font-semibold mr-1" style={{ color: 'var(--primary-text)' }}>
                        {pct}%
                      </span>
                    )}
                    <button
                      type="button"
                      id="acctCheckinAllBtn"
                      disabled={claimingAll || !canClaimAny}
                      onClick={() => void handleClaimAll()}
                      title={
                        canClaimAny
                          ? t('给每个账号各发一次领取（不切换当前账号）', 'Send one claim per account (active account is not switched)')
                          : t('本机所有账号今天都已处理过（已签到或无签到活动）', 'Every local account has been handled today')
                      }
                      className="wb-btn wb-btn-primary wb-btn-sm"
                    >
                      <Gift className="h-3.5 w-3.5" />
                      {claimingAll
                        ? t('领取中…', 'Claiming…')
                        : canClaimAny
                          ? t('全部领取', 'Claim for all')
                          : t('今天都领完了', 'All claimed today')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void loadCheckinAccounts()}
                      title={t('刷新账号', 'Refresh accounts')}
                      className="wb-btn wb-btn-sm"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {activeTotal > 0 && (
                  <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: 'var(--surface-muted)' }} aria-label={t('今日签到完成度', "Today's check-in progress")}>
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: pct === 100 ? 'var(--ok-dot)' : 'var(--primary)' }}
                    />
                  </div>
                )}
              </div>

              {/* Active Program Account Rows */}
              <div className="space-y-2">
                {activeAcctRows.map((a, idx) => (
                  <div
                    key={a.userId || a.authFile || idx}
                    className="rounded-xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2"
                    style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-[13px]" data-i18n-skip="" style={{ color: 'var(--text)' }}>
                          {a.nickname || (a.userId ? `${a.userId.slice(0, 8)}…` : '—')}
                        </span>
                        {a.current && <span className="wb-tag wb-tag-primary">{t('当前', 'Current')}</span>}
                        {a.expired ? (
                          <span className="wb-tag wb-tag-fail">{t('已过期', 'Expired')}</span>
                        ) : a.error ? (
                          <span className="wb-tag wb-tag-fail">{t('失败', 'Failed')}</span>
                        ) : a.status?.todayCheckedIn ? (
                          <span className="wb-tag wb-tag-ok">
                            {t('已签到', 'Checked in')}
                            {(a.status.todayCredit || 0) > 0 ? ` +${a.status.todayCredit}` : ''}
                          </span>
                        ) : (
                          <span className="wb-tag wb-tag-warn">{t('未签到', 'Not checked in')}</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11.5px] mono" style={{ color: 'var(--muted)' }}>
                        {[
                          a.region === 'intl' || a.region === 'global' ? t('国际版', 'Global') : t('国内版', 'China'),
                          a.domain || '',
                          a.expired
                            ? t('已过期', 'Expired')
                            : a.expiresAt
                              ? `${t('剩余', 'TTL')} ${fmtDuration(a.expiresAt - Date.now(), en)}`
                              : '',
                          a.error || '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    {!a.current && (
                      <span className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
                        {t('未使用', 'Not in use')}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Smoothly Collapsible No-Activity Summary */}
              {noActRows.length > 0 && (
                <div className="wb-inset overflow-hidden">
                  <button
                    type="button"
                    id="acctCheckinToggle"
                    onClick={() => setNoActivityOpen((v) => !v)}
                    className="w-full px-3.5 py-2.5 flex items-center justify-between text-[12px] cursor-pointer"
                    style={{ color: 'var(--muted)' }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${noActivityOpen ? 'rotate-90' : ''}`} />
                      <span>
                        {en
                          ? `${noActRows.length} accounts have no program (collapsed)`
                          : `${noActRows.length} 个账号无签到活动，已折叠`}
                      </span>
                    </span>
                    <span className="font-semibold">{noActivityOpen ? t('收起', 'Collapse') : t('展开', 'Expand')}</span>
                  </button>
                  <Collapse open={noActivityOpen} unmountOnExit>
                    <div className="px-3.5 pb-3 space-y-1.5">
                      {noActRows.map((a, i) => (
                        <div
                          key={a.userId || i}
                          className="rounded-lg px-3 py-2 flex items-center justify-between text-[12px]"
                          style={{ background: 'var(--surface)', border: '1px solid var(--border-subtle)', opacity: 0.78 }}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold" data-i18n-skip="">{a.nickname || a.userId?.slice(0, 8)}</span>
                            <span className="wb-tag">{t('无签到活动', 'No check-in program')}</span>
                            <span className="mono text-[11px]" style={{ color: 'var(--muted)' }}>{a.domain || ''}</span>
                          </div>
                          {!a.current && <span className="text-[11px]" style={{ color: 'var(--faint)' }}>{t('未使用', 'Not in use')}</span>}
                        </div>
                      ))}
                    </div>
                  </Collapse>
                </div>
              )}
            </>
          )}
        </div>
      </Panel>
    </div>
  );
};
