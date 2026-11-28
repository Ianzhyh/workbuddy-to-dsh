import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Coins,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  LogOut,
  RefreshCw,
  RotateCcw,
  Shield,
  Users,
  Zap,
} from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { api, copyToClipboard, fmtDateTime, fmtDuration, fmtNum } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { AccountArchiveEntry, AccountArchiveResponse, AccountEntry, PluginCredential } from '../../types/api';
import { useDialog } from '../ui/Dialog';
import { Collapse } from '../ui/Collapse';
import { EmptyState, Panel, SkeletonBlock } from '../ui/Panel';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';

const AUTO_SWITCH_OPTS = [0, 3, 5, 10];

export const AccountsPanel: React.FC = () => {
  const {
    overview,
    accounts,
    accountsStamp,
    autoSwitch,
    pluginLogin,
    probeRunning,
    loadAccounts,
    loadAutoSwitch,
    loadPluginLogin,
    loadOverview,
    loadDiag,
    loadCheckin,
    loadModels,
    resetProbeState,
    setMsg,
  } = useConsole();
  const { en, t } = useI18n();
  const { confirm, prompt, confirmDangerous } = useDialog();

  const [showHidden, setShowHidden] = useState(false);
  const [acctBusy, setAcctBusy] = useState(false);
  const [autoSwitchBusy, setAutoSwitchBusy] = useState(false);
  const [dragName, setDragName] = useState<string | null>(null);
  const [dragOverName, setDragOverName] = useState<string | null>(null);

  // Plugin browser OAuth device flow
  const [loginRegion, setLoginRegion] = useState<'cn' | 'global'>('cn');
  const [regionTouched, setRegionTouched] = useState(false);
  const [startingLogin, setStartingLogin] = useState(false);
  const [pendingAuth, setPendingAuth] = useState<{ state: string; url: string; error?: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  // Account Snapshot Archive drawer
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveItems, setArchiveItems] = useState<AccountArchiveEntry[] | null>(null);

  useEffect(() => {
    if (!regionTouched && pluginLogin?.loginRegion) {
      setLoginRegion(pluginLogin.loginRegion === 'global' ? 'global' : 'cn');
    }
  }, [pluginLogin?.loginRegion, regionTouched]);

  // Deduplicate desktop accounts by aliasKey/account/userId/name
  const desktopRows = useMemo<AccountEntry[]>(() => {
    const raw = accounts?.accounts || [];
    const seen = new Map<string, AccountEntry>();
    const order: string[] = [];
    for (const a of raw) {
      const k = String(a.aliasKey || a.account || a.userId || a.name);
      if (!seen.has(k)) {
        seen.set(k, a);
        order.push(k);
      } else {
        const cur = seen.get(k)!;
        const score = (x: AccountEntry) => (x.active ? 4 : 0) + (x.usable ? 2 : 0);
        if (score(a) > score(cur) || (score(a) === score(cur) && (a.modifiedAt || 0) > (cur.modifiedAt || 0))) {
          seen.set(k, a);
        }
      }
    }
    return order.map((k) => seen.get(k)!);
  }, [accounts?.accounts]);

  const pluginCreds = pluginLogin?.credentials || [];
  const pluginByUid = useMemo(() => {
    const m = new Map<string, PluginCredential>();
    for (const c of pluginCreds) m.set(String(c.uid), c);
    return m;
  }, [pluginCreds]);

  const desktopUids = useMemo(() => new Set(desktopRows.map((a) => String(a.userId || '')).filter(Boolean)), [desktopRows]);
  const pluginOnlyCreds = useMemo(() => pluginCreds.filter((c) => !desktopUids.has(String(c.uid))), [desktopUids, pluginCreds]);

  const hiddenCount = desktopRows.filter((a) => a.hidden).length;
  const visibleDesktop = showHidden ? desktopRows : desktopRows.filter((a) => !a.hidden);
  const activeSource = pluginLogin?.effective?.source || overview?.bridge?.auth?.source || 'desktop';

  // Auto-switch handler (fixes legacy missing handler & missing panel header!)
  const handleAutoSwitch = async (after: number) => {
    setAutoSwitchBusy(true);
    try {
      const r = await api<{ ok?: boolean; after?: number; error?: string }>('/api/auto-switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ after }),
      });
      if (r.ok) {
        setMsg(
          after > 0
            ? t(`已开启自动换号（${after} 次）`, `Auto account switching enabled (${after}x)`)
            : t('已关闭自动换号', 'Automatic account switching disabled'),
          'good',
        );
        await loadAutoSwitch();
      } else {
        setMsg(t('保存失败：', 'Save failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setAutoSwitchBusy(false);
    }
  };

  const handleRename = async (a: AccountEntry) => {
    const val = await prompt(
      t('给这个账号起个名字（留空 = 恢复默认显示）', 'Name this account (leave empty to reset)'),
      a.alias || '',
      { maxLength: 24, placeholder: t('例如：工作号 / 个人号', 'e.g. work / personal'), okText: t('保存', 'Save') },
    );
    if (val === null) return;
    const r = await api<{ ok?: boolean; alias?: string; error?: string }>('/api/account/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: a.name, alias: val }),
    });
    if (r.ok) {
      setMsg(r.alias ? t('账号名字已保存', 'Account name saved') : t('已恢复默认显示', 'Reset to the default label'), 'good');
      await Promise.all([loadAccounts(), loadOverview()]);
    } else {
      setMsg(t('改名失败：', 'Rename failed: ') + (r.error || ''), 'err');
    }
  };

  const commitOrder = async (newVisibleNames: string[]) => {
    const visibleSet = new Set(newVisibleNames);
    const fullOrder = [...newVisibleNames, ...desktopRows.filter((a) => !visibleSet.has(a.name)).map((a) => a.name)];
    const r = await api<{ ok?: boolean; error?: string }>('/api/account/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: fullOrder }),
    });
    if (r.ok) await loadAccounts();
    else setMsg(t('排序保存失败：', 'Failed to save order: ') + (r.error || ''), 'err');
  };

  const handleMove = async (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= visibleDesktop.length) return;
    const names = visibleDesktop.map((a) => a.name);
    [names[idx], names[target]] = [names[target], names[idx]];
    await commitOrder(names);
  };

  const handleToggleHidden = async (a: AccountEntry, hidden: boolean) => {
    const r = await api<{ ok?: boolean; error?: string }>('/api/account/hidden', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: a.name, hidden }),
    });
    if (r.ok) {
      setMsg(
        hidden
          ? t('已隐藏（登录目录里的文件没动，勾「显示已隐藏」可恢复）', 'Hidden (login files untouched; tick "Show hidden" to restore)')
          : t('已恢复显示', 'Shown again'),
        'good',
      );
      await loadAccounts();
    } else {
      setMsg(t('操作失败：', 'Action failed: ') + (r.error || ''), 'err');
    }
  };

  const handleSwitchDesktop = async (a: AccountEntry) => {
    if (a.active && activeSource === 'plugin') {
      await handleSourceChange('desktop');
      return;
    }
    const extra = [
      t('切换会自动重启桥，并清空上一个账号的体检结论（结论只对被测时的账号成立）。', 'Switching restarts the bridge and clears previous probe results.'),
      ...(probeRunning ? [t('体检进行中，停止桥会中断本轮体检。', 'A model probe is running and will be interrupted.')] : []),
    ];
    const ok = await confirmDangerous(t(`确定切换到账号 ${a.alias || a.account || a.name}？`, `Switch bridge to account ${a.alias || a.account || a.name}?`), extra);
    if (!ok) return;
    setAcctBusy(true);
    setMsg(t('正在切换账号，桥会重启，请稍候…', 'Switching account — the bridge will restart, please wait…'));
    try {
      const r = await api<{ switched?: boolean; error?: string }>('/api/account/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: a.name }),
        timeoutMs: 35_000,
      });
      if (r.switched) {
        resetProbeState();
        setMsg(t(`已切换到 ${a.alias || a.account || a.name}`, `Switched to ${a.alias || a.account || a.name}`), 'good');
      } else {
        setMsg(t('切换失败：', 'Switch failed: ') + (r.error || t('未知错误', 'unknown error')), 'err');
      }
      await Promise.all([loadAccounts(), loadOverview(), loadDiag(), loadCheckin(), loadModels()]);
    } finally {
      setAcctBusy(false);
    }
  };

  const handleUsePluginCred = async (uid: string) => {
    setAcctBusy(true);
    try {
      const r = await api<{ ok?: boolean; error?: string }>('/api/login/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid }),
      });
      if (!r.ok) {
        setMsg(t('切换失败：', 'Switch failed: ') + (r.error || ''), 'err');
        return;
      }
      await api('/api/login/source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'plugin' }),
      });
      setMsg(t('已切换到这个账号的插件凭据。', "Switched to this account's plugin credential."), 'good');
      await Promise.all([loadPluginLogin(), loadAccounts(), loadModels(), loadOverview()]);
    } finally {
      setAcctBusy(false);
    }
  };

  const handleLogoutPlugin = async (uid: string) => {
    const ok = await confirm(t('确定清除这个插件账号的凭据？不会注销上游账号。', 'Remove this plugin account credential? This does not sign out the upstream account.'), { danger: true });
    if (!ok) return;
    const r = await api<{ ok?: boolean; error?: string }>('/api/login/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    if (r.ok) {
      setMsg(t('已清除插件凭据。', 'Plugin credential removed.'), 'good');
      await Promise.all([loadPluginLogin(), loadAccounts(), loadModels(), loadOverview()]);
    } else {
      setMsg(t('退出失败：', 'Sign-out failed: ') + (r.error || ''), 'err');
    }
  };

  const handleSourceChange = async (source: string) => {
    const r = await api<{ ok?: boolean; error?: string }>('/api/login/source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (r.ok) {
      setMsg(t('凭据来源已切换。', 'Credential source switched.'), 'good');
      await Promise.all([loadPluginLogin(), loadModels(), loadAccounts(), loadOverview()]);
    } else {
      setMsg(t('切换失败：', 'Switch failed: ') + (r.error || ''), 'err');
    }
  };

  // Device OAuth polling
  const stopPoll = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => () => stopPoll(), []);

  const pollDeviceOnce = async (stateId: string) => {
    setCheckingAuth(true);
    try {
      const r = await api<{ status?: string; effectiveSource?: string; error?: string }>('/api/login/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: stateId }),
      });
      if (r.status === 'ready') {
        stopPoll();
        setPendingAuth(null);
        setMsg(
          r.effectiveSource === 'plugin'
            ? t('登录成功，当前使用插件账号。', 'Signed in; the plugin account is in use.')
            : t('登录成功；当前凭据来源未切换（被环境变量锁定），插件账号尚未生效。', 'Signed in, but the credential source is pinned by an environment variable.'),
          'good',
        );
        await Promise.all([loadPluginLogin(), loadAccounts(), loadModels(), loadOverview()]);
      } else if (r.status !== 'pending') {
        stopPoll();
        setPendingAuth((prev) => (prev && prev.state === stateId ? { ...prev, error: r.error || t('登录未完成', 'Sign-in not completed') } : prev));
      }
    } finally {
      setCheckingAuth(false);
    }
  };

  const handleStartLogin = async () => {
    setStartingLogin(true);
    try {
      const r = await api<{ ok?: boolean; state?: string; url?: string; error?: string }>('/api/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: loginRegion, open: true }),
      });
      if (r.ok && r.state && r.url) {
        setPendingAuth({ state: r.state, url: r.url });
        setMsg(t('已生成授权链接：请在浏览器打开并完成登录。', 'Authorization link created; open it in your browser to finish signing in.'), 'good');
        stopPoll();
        const st = r.state;
        pollTimerRef.current = window.setInterval(() => void pollDeviceOnce(st), 3500);
      } else {
        setMsg(t('发起登录失败：', 'Could not start sign-in: ') + (r.error || ''), 'err');
      }
    } finally {
      setStartingLogin(false);
    }
  };

  const handleCancelLogin = async () => {
    stopPoll();
    const st = pendingAuth?.state;
    setPendingAuth(null);
    if (st) {
      await api('/api/login/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: st }),
      });
    }
    setMsg(t('已取消本次登录。', 'Sign-in cancelled.'));
  };

  // Account Archive / Recovery
  const loadArchive = async () => {
    setArchiveBusy(true);
    try {
      const r = await api<AccountArchiveResponse>('/api/account/archive');
      const list = r.entries || r.archived || [];
      setArchiveItems(Array.isArray(list) ? list : []);
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleSweepArchive = async () => {
    setArchiveBusy(true);
    try {
      const r = await api<AccountArchiveResponse>('/api/account/archive', { method: 'POST' });
      if (r.ok) {
        setMsg(t('已扫描并保存本机账号快照。', 'Scanned and archived local account snapshots.'), 'good');
        await loadArchive();
      } else {
        setMsg(t('存档失败：', 'Archive failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleRestoreArchive = async (entry: AccountArchiveEntry) => {
    const ok = await confirm(t(`将存档快照 ${entry.account || entry.key} 恢复到登录目录？`, `Restore archived snapshot ${entry.account || entry.key} to login directory?`));
    if (!ok) return;
    setArchiveBusy(true);
    try {
      const r = await api<{ ok?: boolean; error?: string }>('/api/account/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: entry.key, ...(entry.file ? { file: entry.file } : {}) }),
      });
      if (r.ok) {
        setMsg(t('快照已恢复到登录目录。', 'Snapshot restored to login directory.'), 'good');
        await Promise.all([loadAccounts(), loadOverview()]);
      } else {
        setMsg(t('恢复失败：', 'Restore failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleRebuildFromPlugin = async () => {
    const ok = await confirm(t('从插件凭据反向重建桌面登录快照？', 'Rebuild desktop login snapshot from plugin credentials?'));
    if (!ok) return;
    setArchiveBusy(true);
    try {
      const r = await api<{ ok?: boolean; error?: string }>('/api/account/rebuild', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        setMsg(t('已根据插件凭据重建快照。', 'Rebuilt snapshot from plugin credentials.'), 'good');
        await Promise.all([loadAccounts(), loadOverview()]);
      } else {
        setMsg(t('重建失败：', 'Rebuild failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setArchiveBusy(false);
    }
  };

  const currentAfter = autoSwitch?.after ?? 0;

  return (
    <div data-section="overview" className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-stretch">
      {/* Left 7 cols: Accounts & Auto-Switch */}
      <Panel
        className="xl:col-span-7"
        title={t('账号', 'Account')}
        subtitle={t('切换当前服务账号、排序、别名与自动换号策略', 'Switch active account, reorder, alias, and auto-failover policy')}
        helpText={t(
          '登录目录下有多个账号快照时可切换桥使用哪一个（会自动重启桥并清空体检结论）。隐藏只记在本地 .state.json 中，绝不删改登录目录文件。同账号多快照与插件凭据自动合并为一行。',
          'Switch between local login snapshots (restarts bridge and clears probe results). Hiding only updates .state.json and never deletes desktop login files. Multiple snapshots or dual credentials for the same account merge automatically.',
        )}
        icon={<Users className="h-4 w-4" />}
        stamp={accountsStamp ? t(`更新于 ${accountsStamp}`, `Updated ${accountsStamp}`) : undefined}
        stampId="accountsStamp"
        actions={
          <div className="flex items-center gap-2.5">
            <Switch
              id="acctShowHidden"
              checked={showHidden}
              onChange={setShowHidden}
              label={t('显示已隐藏', 'Show hidden')}
              badge={hiddenCount > 0 ? <span id="acctHiddenCount" className="wb-tag">{hiddenCount}</span> : undefined}
            />
            <button
              type="button"
              onClick={() => {
                const next = !archiveOpen;
                setArchiveOpen(next);
                if (next && archiveItems === null) void loadArchive();
              }}
              className="wb-btn wb-btn-sm"
            >
              <Archive className="h-3.5 w-3.5" />
              {t('快照存档', 'Snapshots')}
            </button>
          </div>
        }
      >
        {/* Auto-Switch Strip */}
        <div
          id="autoSwitchBox"
          className="wb-inset mb-4 p-3.5 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                {t('自动换号', 'Auto account switching')}
              </span>
              <span id="autoSwitchState" className={`wb-tag ${currentAfter > 0 ? 'wb-tag-ok' : ''}`}>
                {currentAfter > 0 ? t(`已开启（${currentAfter} 次）`, `On (${currentAfter}x)`) : t('已关闭', 'Off')}
              </span>
            </div>
            <p className="mt-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>
              {t(
                '同一模型 10 分钟内限流达阈值后自动切号；额度用尽与风控一次即切。',
                'Auto-switches after hitting 429 threshold within 10m; quota & risk rejections switch immediately.',
              )}
            </p>
          </div>
          <SegmentedControl
            value={String(currentAfter)}
            ariaLabel={t('自动换号阈值', 'Auto account switching threshold')}
            onChange={(v) => void handleAutoSwitch(Number(v) || 0)}
            options={AUTO_SWITCH_OPTS.map((val) => ({
              value: String(val),
              label: val === 0 ? t('关闭', 'Off') : t(`${val} 次`, `${val}x`),
              disabled: autoSwitchBusy,
              dataAttr: { 'data-autoswitch': String(val) },
              buttonClassName: currentAfter === val ? 'on' : '',
            }))}
          />
        </div>

        {/* Account Source Note */}
        {activeSource === 'plugin' && (
          <div
            id="accountSourceNote"
            className="mb-3 rounded-lg px-3 py-2 text-[12px]"
            style={{ background: 'var(--info-soft)', border: '1px solid var(--info-border)', color: 'var(--info)' }}
          >
            {pluginLogin?.sameAccount
              ? t('当前实际使用插件账号，且与桌面端选中的是同一账号；两条凭据互通。', 'Currently using plugin sign-in on the same account as desktop; credentials are interchangeable.')
              : t('当前实际使用插件账号；桌面端账号若与插件端同账号，会在该行显示「双凭据」。', 'Currently using the plugin account; matching desktop rows show "Dual credentials".')}
          </div>
        )}

        {/* Account List */}
        <div id="accountList" className="space-y-2.5">
          {!accounts ? (
            <SkeletonBlock lines={3} />
          ) : visibleDesktop.length === 0 && pluginOnlyCreds.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" />}
              title={
                hiddenCount > 0
                  ? t('全部账号都被隐藏了 —— 勾选上方「显示已隐藏」可以恢复。', 'All accounts are hidden — tick "Show hidden" above to restore them.')
                  : t('未找到账号快照。', 'No account snapshot found.')
              }
            />
          ) : (
            <>
              {visibleDesktop.map((a, idx) => {
                const pluginFor = a.userId ? pluginByUid.get(String(a.userId)) : undefined;
                const isEffective = (pluginFor?.active && activeSource === 'plugin') || (a.active && activeSource !== 'plugin');
                const title = a.alias || a.account || a.name;
                return (
                  <div
                    key={a.name}
                    draggable
                    onDragStart={() => setDragName(a.name)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverName(a.name);
                    }}
                    onDragLeave={() => setDragOverName(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverName(null);
                      if (!dragName || dragName === a.name) return;
                      const names = visibleDesktop.map((x) => x.name);
                      const from = names.indexOf(dragName);
                      const to = names.indexOf(a.name);
                      if (from >= 0 && to >= 0) {
                        const [moved] = names.splice(from, 1);
                        names.splice(to, 0, moved);
                        void commitOrder(names);
                      }
                      setDragName(null);
                    }}
                    className="group rounded-[12px] p-3.5 transition-all"
                    style={{
                      background: isEffective ? 'var(--surface-elevated)' : 'var(--surface-tint)',
                      border: `1px solid ${dragOverName === a.name ? 'var(--primary)' : isEffective ? 'var(--primary-border)' : 'var(--border-subtle)'}`,
                      boxShadow: isEffective ? 'var(--shadow-xs), var(--specular)' : 'none',
                      opacity: a.hidden ? 0.65 : 1,
                    }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2.5">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <span
                          title={t('拖动排序', 'Drag to reorder')}
                          className="mt-0.5 cursor-grab opacity-45 group-hover:opacity-90"
                          style={{ color: 'var(--muted)' }}
                        >
                          <GripVertical className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-[13.5px] truncate" data-i18n-skip="" style={{ color: 'var(--text)' }}>
                              {title}
                            </span>
                            {isEffective ? (
                              <span className="wb-tag wb-tag-ok">{t('使用中', 'In use')}</span>
                            ) : a.active ? (
                              <span className="wb-tag wb-tag-warn">{t('已选（未生效）', 'Selected (not in use)')}</span>
                            ) : null}
                            <span
                              className={`wb-tag ${a.usable ? 'wb-tag-ok' : 'wb-tag-fail'}`}
                              title={a.error || ''}
                            >
                              {a.usable ? t('可用', 'Available') : t('不可用', 'Unavailable')}
                            </span>
                            {pluginFor && <span className="wb-tag wb-tag-info">{t('双凭据', 'Dual credentials')}</span>}
                            {a.hidden && <span className="wb-tag">{t('已隐藏', 'Hidden')}</span>}
                            {a.balance !== undefined && (
                              <span
                                className="acct-balance wb-tag wb-tag-warn"
                                title={a.balanceError || t('账号积分余额', 'Account credit balance')}
                              >
                                <Coins className="h-3 w-3" />
                                {typeof a.balance === 'number' ? fmtNum(a.balance) : '—'}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[11.5px] mono truncate" style={{ color: 'var(--muted)' }}>
                            {[
                              a.alias && a.account ? a.account : '',
                              a.name,
                              a.domain || '',
                              a.remainingMs != null ? `${t('剩余', 'TTL')} ${fmtDuration(a.remainingMs, en)}` : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                          {pluginFor && (
                            <div className="mt-1 text-[11.5px]" style={{ color: 'var(--info)' }}>
                              {t('插件凭据 · ', 'Plugin credential · ')}
                              {pluginFor.nickname || pluginFor.uid.slice(0, 8)}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1 shrink-0">
                        {!isEffective && (
                          <button
                            type="button"
                            disabled={acctBusy || !a.usable}
                            onClick={() => void handleSwitchDesktop(a)}
                            className="wb-btn wb-btn-primary wb-btn-sm"
                          >
                            {a.active && activeSource === 'plugin' ? t('改用桌面端', 'Use desktop') : t('切换', 'Switch')}
                          </button>
                        )}
                        {pluginFor && !(pluginFor.active && activeSource === 'plugin') && (
                          <button
                            type="button"
                            disabled={acctBusy}
                            onClick={() => void handleUsePluginCred(pluginFor.uid)}
                            className="wb-btn wb-btn-sm"
                          >
                            {t('用插件凭据', 'Use plugin')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleRename(a)}
                          title={t('改名', 'Rename')}
                          aria-label={t('改名', 'Rename')}
                          className="wb-btn wb-btn-ghost wb-btn-sm px-1.5"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => void handleMove(idx, -1)}
                          title={t('上移', 'Move up')}
                          aria-label={t('上移', 'Move up')}
                          className="wb-btn wb-btn-ghost wb-btn-sm px-1.5"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === visibleDesktop.length - 1}
                          onClick={() => void handleMove(idx, 1)}
                          title={t('下移', 'Move down')}
                          aria-label={t('下移', 'Move down')}
                          className="wb-btn wb-btn-ghost wb-btn-sm px-1.5"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        {!a.active && (
                          <button
                            type="button"
                            onClick={() => void handleToggleHidden(a, !a.hidden)}
                            title={a.hidden ? t('恢复', 'Restore') : t('隐藏', 'Hide')}
                            aria-label={a.hidden ? t('恢复', 'Restore') : t('隐藏', 'Hide')}
                            className="wb-btn wb-btn-ghost wb-btn-sm px-1.5"
                          >
                            {a.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Plugin-only accounts */}
              {pluginOnlyCreds.map((c) => {
                const eff = c.active && activeSource === 'plugin';
                return (
                  <div
                    key={c.uid}
                    className="rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2.5"
                    style={{
                      background: eff ? 'var(--primary-soft)' : 'var(--surface-subtle)',
                      border: `1px solid ${eff ? 'var(--primary-border)' : 'var(--border)'}`,
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-[13.5px]" data-i18n-skip="" style={{ color: 'var(--text)' }}>
                          {c.nickname || `UID ${c.uid.slice(0, 8)}…`}
                        </span>
                        <span className="wb-tag wb-tag-info">{t('插件', 'Plugin')}</span>
                        <span className={`wb-tag ${eff ? 'wb-tag-ok' : ''}`}>
                          {eff ? t('使用中', 'In use') : t('未使用', 'Not in use')}
                        </span>
                        {c.enterpriseId && <span className="wb-tag wb-tag-promo">{t('企业版', 'Enterprise')}</span>}
                      </div>
                      <div className="mt-1 text-[11.5px] mono" style={{ color: 'var(--muted)' }}>
                        {[
                          c.region === 'global' ? t('国际版', 'Global') : t('国内版', 'China'),
                          `UID ${c.uid.slice(0, 8)}…`,
                          c.remainingMs != null ? `${t('剩余', 'TTL')} ${fmtDuration(c.remainingMs, en)}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!eff && (
                        <button
                          type="button"
                          disabled={acctBusy}
                          onClick={() => void handleUsePluginCred(c.uid)}
                          className="wb-btn wb-btn-primary wb-btn-sm"
                        >
                          {t('使用', 'Use')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleLogoutPlugin(c.uid)}
                        className="wb-btn wb-btn-danger wb-btn-sm"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        {t('退出', 'Sign out')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Smoothly Collapsible Account Snapshot Archive & Recovery */}
        <Collapse open={archiveOpen} unmountOnExit>
          <div className="wb-inset mt-4 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                  {t('账号快照存档与恢复', 'Account Snapshot Archive & Recovery')}
                </div>
                <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                  {t('客户端换号覆盖登录文件后，可从存档或插件凭据找回账号，无需重新登录。', 'Recover overwritten desktop accounts from archived snapshots or plugin credentials.')}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={archiveBusy} onClick={() => void handleSweepArchive()} className="wb-btn wb-btn-sm">
                  <RefreshCw className={`h-3.5 w-3.5 ${archiveBusy ? 'animate-spin' : ''}`} />
                  {t('立即存档', 'Archive now')}
                </button>
                <button type="button" disabled={archiveBusy} onClick={() => void handleRebuildFromPlugin()} className="wb-btn wb-btn-sm">
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('从插件重建', 'Rebuild from plugin')}
                </button>
              </div>
            </div>
            {archiveItems === null ? (
              <SkeletonBlock lines={2} />
            ) : archiveItems.length === 0 ? (
              <div className="text-[12px] py-2" style={{ color: 'var(--muted)' }}>
                {t('暂无已存档快照，点击「立即存档」可保存当前登录目录快照。', 'No archived snapshots yet. Click "Archive now" to snapshot current login files.')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {archiveItems.map((entry) => (
                  <div
                    key={entry.key + (entry.file || '')}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12px]"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="min-w-0">
                      <span className="font-semibold mono" data-i18n-skip="">{entry.account || entry.uin || entry.key}</span>
                      <span className="ml-2" style={{ color: 'var(--muted)' }}>
                        {[entry.domain, entry.savedAt ? fmtDateTime(entry.savedAt) : ''].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={archiveBusy}
                      onClick={() => void handleRestoreArchive(entry)}
                      className="wb-btn wb-btn-sm"
                    >
                      {t('恢复', 'Restore')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Collapse>
      </Panel>

      {/* Right 5 cols: Plugin Browser Login (Equal-Height Grouped Settings Layout) */}
      <Panel
        className="xl:col-span-5"
        title={t('插件登录', 'Plugin sign-in')}
        subtitle={t('浏览器直连授权，不依赖桌面端，可随时切换凭据来源', 'Browser OAuth sign-in without desktop app; switch credential source anytime')}
        icon={<KeyRound className="h-4 w-4" />}
      >
        <div id="pluginLoginBody" className="flex-1 flex flex-col gap-3.5">
          {!pluginLogin ? (
            <SkeletonBlock lines={4} />
          ) : !pluginLogin.ok ? (
            <div className="wb-inset px-3.5 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>
              {t('桥未运行，无法读取凭据来源。', 'Bridge is not running; cannot read credential sources.')}
            </div>
          ) : (
            <>
              {/* 1. Grouped Credential Routing & Security Table */}
              <div className="wb-inset overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                  <label htmlFor="pluginLoginSource" className="text-[12.5px] font-medium" style={{ color: 'var(--text)' }}>
                    {t('凭据来源', 'Credential source')}
                  </label>
                  {pluginLogin.envPinned ? (
                    <span className="wb-tag wb-tag-warn">
                      {pluginLogin.configured || 'auto'} {t('（由环境变量锁定）', '(pinned by env)')}
                    </span>
                  ) : (
                    <Select
                      id="pluginLoginSource"
                      title={t('凭据来源', 'Credential source')}
                      value={pluginLogin.configured || 'auto'}
                      onChange={(v) => void handleSourceChange(v)}
                      options={[
                        {
                          value: 'auto',
                          label: pluginLogin.desktop?.available
                            ? t('自动（桌面端优先）', 'Auto (desktop first)')
                            : t('自动', 'Auto'),
                        },
                        ...(pluginLogin.desktop?.available || pluginLogin.configured === 'desktop'
                          ? [{ value: 'desktop', label: t('仅桌面端', 'Desktop only') }]
                          : []),
                        { value: 'plugin', label: t('仅插件登录', 'Plugin sign-in only') },
                      ]}
                      menuMinWidth={176}
                    />
                  )}
                </div>

                <div
                  className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-[12px]"
                  style={{ borderTop: '1px solid var(--border-subtle)' }}
                >
                  <span style={{ color: 'var(--muted)' }}>{t('当前实际使用', 'Effective source')}</span>
                  <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--text)' }}>
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: pluginLogin.effective?.source === 'plugin' ? 'var(--info-dot)' : 'var(--ok-dot)' }}
                    />
                    {pluginLogin.effective?.source === 'plugin' ? t('插件登录', 'Plugin sign-in') : t('桌面端', 'Desktop')}
                  </span>
                </div>

                <div
                  className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-[12px]"
                  style={{ borderTop: '1px solid var(--border-subtle)' }}
                >
                  <span style={{ color: 'var(--muted)' }}>{t('凭据存储', 'Credential store')}</span>
                  <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-secondary)' }}>
                    <Shield className="h-3.5 w-3.5" style={{ color: pluginLogin.storeMode === 'dpapi' ? 'var(--ok-dot)' : 'var(--warn-dot)' }} />
                    {pluginLogin.storeMode === 'dpapi'
                      ? t('DPAPI 本机加密', 'DPAPI encrypted')
                      : t('仅内存保存', 'Memory only')}
                  </span>
                </div>
              </div>

              {pluginLogin.fallbackReason && (
                <div className="rounded-xl px-3.5 py-2.5 text-[12px]" style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn-border)', color: 'var(--warn)' }}>
                  {t('凭据加密存储不可用，本次登录只保存在内存：', 'Encrypted credential storage unavailable; kept in memory only: ')}
                  {pluginLogin.fallbackReason}
                </div>
              )}
              {pluginLogin.plugin?.error && (
                <div className="rounded-xl px-3.5 py-2.5 text-[12px]" style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}>
                  {t('插件凭据读取失败：', 'Could not read plugin credential: ')}
                  {pluginLogin.plugin.error}
                </div>
              )}
              {pluginLogin.configured === 'desktop' && !pluginLogin.desktop?.available && (
                <div className="rounded-xl px-3.5 py-2.5 text-[12px]" style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn-border)', color: 'var(--warn)' }}>
                  {t('桌面端登录态当前不可用；请选择「自动」或改用插件登录。', 'Desktop login unavailable right now. Choose "Auto" or use plugin sign-in.')}
                </div>
              )}

              {/* 2. Browser OAuth Authorization Card */}
              <div className="wb-inset p-3.5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>
                      {t('新增浏览器授权', 'Add via browser OAuth')}
                    </div>
                    <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                      {t('选择账号区域并打开浏览器完成一次性授权', 'Pick region and authorize in your browser')}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    id="pluginLoginRegion"
                    title={t('登录区域', 'Sign-in region')}
                    value={loginRegion}
                    onChange={(v) => {
                      setRegionTouched(true);
                      setLoginRegion(v === 'global' ? 'global' : 'cn');
                    }}
                    options={[
                      { value: 'cn', label: t('国内版', 'China') },
                      { value: 'global', label: t('国际版', 'Global') },
                    ]}
                    menuMinWidth={128}
                  />
                  <button
                    type="button"
                    disabled={startingLogin}
                    onClick={() => void handleStartLogin()}
                    className="wb-btn wb-btn-accent wb-btn-sm flex-1 min-w-[120px]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {startingLogin ? t('正在创建…', 'Creating…') : t('开始登录', 'Sign in')}
                  </button>
                </div>

                {/* Smoothly Collapsible Pending Device Flow Box */}
                <Collapse open={Boolean(pendingAuth)} unmountOnExit>
                  {pendingAuth && (
                    <div
                      className="mt-1 rounded-xl p-3 space-y-2.5"
                      style={{ background: 'var(--surface)', border: '1px solid var(--primary-border)' }}
                    >
                      <div className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
                        {t('请在浏览器打开并完成授权（约 10 分钟内有效），本页每 3.5 秒自动检查一次。', 'Open the link below in your browser to authorize (valid ~10m). Checking every 3.5s.')}
                      </div>
                      <a
                        href={pendingAuth.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block mono text-[11px] break-all underline"
                        style={{ color: 'var(--primary-text)' }}
                      >
                        {pendingAuth.url}
                      </a>
                      {pendingAuth.error && (
                        <div className="text-[12px] font-medium" style={{ color: 'var(--fail)' }}>
                          {t('登录未完成：', 'Sign-in not completed: ')}{pendingAuth.error}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            const ok = await copyToClipboard(pendingAuth.url);
                            if (ok) setMsg(t('授权链接已复制', 'Authorization link copied'), 'good');
                          }}
                          className="wb-btn wb-btn-sm"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t('复制链接', 'Copy link')}
                        </button>
                        <button
                          type="button"
                          disabled={checkingAuth}
                          onClick={() => void pollDeviceOnce(pendingAuth.state)}
                          className="wb-btn wb-btn-primary wb-btn-sm"
                        >
                          {checkingAuth ? t('检查中…', 'Checking…') : t('我已完成授权', 'I have authorized')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCancelLogin()}
                          className="wb-btn wb-btn-ghost wb-btn-sm"
                        >
                          {t('取消', 'Cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </Collapse>
              </div>

              {/* 3. Authorized Plugin Credentials Roster (fills panel with real actionable value!) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between px-0.5">
                  <span className="text-[11.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                    {t('已授权插件凭据', 'Authorized plugin credentials')}
                  </span>
                  <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>
                    {pluginCreds.length}
                  </span>
                </div>

                {pluginCreds.length === 0 ? (
                  <div className="wb-inset px-3.5 py-3 text-[12px]" style={{ color: 'var(--muted)' }}>
                    {t('暂无已保存的插件凭据。点击上方「开始登录」即可通过浏览器添加。', 'No saved plugin credentials yet. Click "Sign in" above to add one.')}
                  </div>
                ) : (
                  <div className="wb-inset overflow-hidden divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                    {pluginCreds.map((c, idx) => {
                      const eff = c.active && activeSource === 'plugin';
                      const name = c.nickname || `UID ${c.uid.slice(0, 8)}…`;
                      return (
                        <div
                          key={c.uid}
                          className="px-3.5 py-2.5 flex items-center justify-between gap-2.5"
                          style={{
                            borderTop: idx > 0 ? '1px solid var(--border-subtle)' : 'none',
                            background: eff ? 'var(--surface-elevated)' : 'transparent',
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className="h-1.5 w-1.5 rounded-full shrink-0"
                                style={{ background: eff ? 'var(--ok-dot)' : c.expired ? 'var(--fail-dot)' : 'var(--faint)' }}
                              />
                              <span className="text-[12.5px] font-semibold truncate" data-i18n-skip="" style={{ color: 'var(--text)' }}>
                                {name}
                              </span>
                              <span className="wb-tag">{c.region === 'global' ? t('国际版', 'Global') : t('国内版', 'China')}</span>
                              {eff && <span className="wb-tag wb-tag-ok">{t('生效中', 'Active')}</span>}
                            </div>
                            <div className="mt-0.5 mono text-[11px] truncate" style={{ color: 'var(--faint)' }}>
                              UID {c.uid.slice(0, 8)}…
                              {c.remainingMs != null ? ` · ${t('剩余', 'TTL')} ${fmtDuration(c.remainingMs, en)}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {!eff && (
                              <button
                                type="button"
                                disabled={acctBusy}
                                onClick={() => void handleUsePluginCred(c.uid)}
                                className="wb-btn wb-btn-sm"
                              >
                                {t('使用', 'Use')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleLogoutPlugin(c.uid)}
                              title={t('退出并清除凭据', 'Sign out & remove credential')}
                              aria-label={t(`退出 ${name}`, `Sign out ${name}`)}
                              className="wb-btn wb-btn-ghost wb-btn-sm px-2"
                              style={{ color: 'var(--fail)' }}
                            >
                              <LogOut className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
};
