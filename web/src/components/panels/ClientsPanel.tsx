import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Link2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Star,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { api, connectRead, copyToClipboard, lsGet, lsSet } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { ClientsResponse, ConnectClientPlan, ConnectVerifyResult } from '../../types/api';
import { AnimatedDetails } from '../ui/AnimatedDetails';
import { CopyButton } from '../ui/CopyButton';
import { Collapse } from '../ui/Collapse';
import { useDialog } from '../ui/Dialog';
import { Panel, SkeletonBlock } from '../ui/Panel';
import { SegmentedControl } from '../ui/SegmentedControl';

type ManualTab = 'opencode' | 'claude' | 'codex' | 'form' | 'other';

interface SavedSelection {
  models: Record<string, string[]>;
  model: Record<string, string>;
}

function loadSavedConnectSel(): SavedSelection {
  try {
    const raw = JSON.parse(lsGet('wb-connect-selection', '{}')) as Partial<SavedSelection>;
    return {
      models: raw?.models && typeof raw.models === 'object' ? raw.models : {},
      model: raw?.model && typeof raw.model === 'object' ? raw.model : {},
    };
  } catch {
    return { models: {}, model: {} };
  }
}

export const ClientsPanel: React.FC = () => {
  const { clients, clientsStamp, connect, connectError, models, loadConnect, setMsg } = useConsole();
  const { en, t } = useI18n();
  const { confirm } = useDialog();

  // One-click connect interactive state
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const [savedSel, setSavedSel] = useState<SavedSelection>(() => loadSavedConnectSel());
  const [modelFilterByClient, setModelFilterByClient] = useState<Record<string, string>>({});
  const [busyClientId, setBusyClientId] = useState<string | null>(null);
  const [verifyMap, setVerifyMap] = useState<Record<string, { state: 'loading' | 'done'; result?: ConnectVerifyResult }>>({});
  const [opResultMap, setOpResultMap] = useState<Record<string, { ok: boolean; lines: string[] }>>({});

  // Manual setup studio state
  const [manualOpen, setManualOpen] = useState(false);
  const [previewOpenByClient, setPreviewOpenByClient] = useState<Record<string, boolean>>({});
  const [manualTab, setManualTab] = useState<ManualTab>('opencode');
  const [manualSelectedModels, setManualSelectedModels] = useState<string[] | null>(null);

  const catalog = models?.models || [];

  // Persist connect selection
  const updateSavedSel = (next: SavedSelection, refetch = true) => {
    setSavedSel(next);
    lsSet('wb-connect-selection', JSON.stringify(next));
    if (refetch) {
      const qs = new URLSearchParams();
      for (const [cid, m] of Object.entries(next.model)) {
        if (m) qs.set(`model.${cid}`, m);
      }
      for (const [cid, list] of Object.entries(next.models)) {
        if (list.length) qs.set(`models.${cid}`, list.join(','));
      }
      void loadConnect(qs.toString());
    }
  };

  // Close open client drawer on Esc
  useEffect(() => {
    if (!openClientId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenClientId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openClientId]);

  // Auto-verify connected non-drifted clients silently when connect data loads
  useEffect(() => {
    if (!connect?.clients?.length) return;
    for (const c of connect.clients) {
      const connected = Boolean(c.applied || (c.exists && !c.changed));
      if (connected && !c.changed && c.mode !== 'native' && !verifyMap[c.id]) {
        void runVerify(c.id, true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  const runVerify = async (clientId: string, quiet = false) => {
    setVerifyMap((prev) => ({ ...prev, [clientId]: { state: 'loading' } }));
    const r = await connectRead<ConnectVerifyResult>('/api/connect/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client: clientId,
        ...(savedSel.model[clientId] ? { model: savedSel.model[clientId] } : {}),
        ...(savedSel.models[clientId]?.length ? { models: savedSel.models[clientId] } : {}),
      }),
    });
    const res: ConnectVerifyResult = r.body || { ok: false, error: r.netError || `HTTP ${r.status}` };
    setVerifyMap((prev) => ({ ...prev, [clientId]: { state: 'done', result: res } }));
    if (!quiet) {
      setMsg(res.ok ? t(`${clientId} 验证通过`, `${clientId} verified`) : t(`${clientId} 验证未通过`, `${clientId} verification failed`), res.ok ? 'good' : 'err');
    }
  };

  const handleApply = async (c: ConnectClientPlan) => {
    const changesText = (c.changes || [])
      .slice(0, 6)
      .map((ch) => `· ${ch.path}: ${ch.from == null ? t('新增', 'add') : `${String(ch.from)} → ${String(ch.to)}`}`)
      .join('\n');
    const ok = await confirm(
      [
        t(`确定写入 ${c.label} 配置文件？`, `Write configuration to ${c.label}?`),
        c.path,
        changesText,
        c.reformats ? t('注：保存时会按标准 2 空格 JSON 重新格式化。', 'Note: file will be reformatted with 2-space JSON.') : '',
        t('原文件会自动备份，可随时一键撤销或切回原始模型。', 'Original file is automatically backed up and can be undone anytime.'),
      ]
        .filter(Boolean)
        .join('\n'),
    );
    if (!ok) return;

    setBusyClientId(c.id);
    try {
      const r = await api<{
        ok?: boolean;
        changed?: boolean;
        backup?: string;
        warning?: string;
        error?: string;
        auth?: { ok?: boolean; error?: string };
      }>('/api/connect/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client: c.id,
          ...(savedSel.model[c.id] ? { model: savedSel.model[c.id] } : {}),
          ...(savedSel.models[c.id]?.length ? { models: savedSel.models[c.id] } : {}),
        }),
      });
      const lines: string[] = [];
      if (r.ok) {
        lines.push(r.changed ? t('配置已写入，重启该客户端后生效。', 'Configuration written. Restart the client to take effect.') : t('配置已是最新，无需改动。', 'Configuration already up to date.'));
        if (r.backup) lines.push(`${t('原文件已备份到：', 'Backed up to: ')}${r.backup}`);
        if (r.auth) lines.push(r.auth.ok ? t('端到端鉴权验证：通过', 'Live auth check: passed') : `${t('端到端鉴权验证失败：', 'Live auth check failed: ')}${r.auth.error || ''}`);
        if (r.warning) lines.push(r.warning);
        setMsg(t(`已写入 ${c.label} 配置`, `Applied config to ${c.label}`), 'good');
      } else {
        lines.push(r.error || t('写入失败', 'Apply failed'));
        setMsg(`${t('写入失败：', 'Apply failed: ')}${r.error || ''}`, 'err');
      }
      setOpResultMap((prev) => ({ ...prev, [c.id]: { ok: Boolean(r.ok), lines } }));
      await loadConnect();
    } finally {
      setBusyClientId(null);
    }
  };

  const handleModeSwitch = async (c: ConnectClientPlan, targetMode: 'native' | 'bridge') => {
    const ok = await confirm(
      targetMode === 'native'
        ? t(`把 ${c.label} 切回客户端自己的原始模型？接入记录会保留，随时可一键切回桥。`, `Switch ${c.label} back to native models? Bridge settings stay recorded for one-click re-enable.`)
        : t(`把 ${c.label} 切回走 WorkBuddy 本地桥？`, `Switch ${c.label} back to WorkBuddy local bridge?`),
    );
    if (!ok) return;
    setBusyClientId(c.id);
    try {
      const r = await api<{ ok?: boolean; error?: string; warning?: string }>('/api/connect/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: c.id, mode: targetMode }),
      });
      if (r.ok) {
        if (targetMode === 'native') {
          setVerifyMap((prev) => {
            const copy = { ...prev };
            delete copy[c.id];
            return copy;
          });
        }
        setOpResultMap((prev) => ({
          ...prev,
          [c.id]: {
            ok: true,
            lines: [
              targetMode === 'native'
                ? t('已切回客户端原始模型（重启客户端后生效）。', 'Switched back to native models (restart client).')
                : t('已切回本地桥模型（重启客户端后生效）。', 'Switched to local bridge (restart client).'),
              ...(r.warning ? [r.warning] : []),
            ],
          },
        }));
        setMsg(t(`已切换 ${c.label} 模式`, `Switched ${c.label} mode`), 'good');
        await loadConnect();
      } else {
        setMsg(t('切换失败：', 'Mode switch failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setBusyClientId(null);
    }
  };

  const handleUndo = async (c: ConnectClientPlan) => {
    const ok = await confirm(
      t(`撤销 ${c.label} 的一键接入？将还原受管配置键并归档记录。`, `Undo ${c.label} integration? Managed keys will be restored from backup records.`),
      { danger: true },
    );
    if (!ok) return;
    setBusyClientId(c.id);
    try {
      const r = await api<{ ok?: boolean; error?: string; warning?: string }>('/api/connect/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: c.id }),
      });
      if (r.ok) {
        setOpResultMap((prev) => ({
          ...prev,
          [c.id]: { ok: true, lines: [t('已撤销接入并还原原配置。', 'Integration undone and config restored.'), ...(r.warning ? [r.warning] : [])] },
        }));
        setMsg(t(`已撤销 ${c.label} 接入`, `Undid ${c.label} integration`), 'good');
        await loadConnect();
      } else {
        setMsg(t('撤销失败：', 'Undo failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setBusyClientId(null);
    }
  };

  const handleProfileAction = async (c: ConnectClientPlan, action: 'apply' | 'undo') => {
    if (!c.profile) return;
    setBusyClientId(c.id);
    try {
      const path = action === 'apply' ? '/api/connect/apply' : '/api/connect/undo';
      const r = await api<{ ok?: boolean; error?: string }>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client: c.profile.id,
          ...(action === 'apply' && savedSel.model[c.id] ? { model: savedSel.model[c.id] } : {}),
          ...(action === 'apply' && savedSel.models[c.id]?.length ? { models: savedSel.models[c.id] } : {}),
        }),
      });
      if (r.ok) {
        setMsg(
          action === 'apply'
            ? t(`已写入 profile 文件，运行：${c.profile.launch}`, `Profile written. Launch with: ${c.profile.launch}`)
            : t('已删除 Codex profile 文件。', 'Deleted Codex profile file.'),
          'good',
        );
        await loadConnect();
      } else {
        setMsg(t('操作失败：', 'Action failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setBusyClientId(null);
    }
  };

  const getRowStatus = (c: ConnectClientPlan) => {
    const v = verifyMap[c.id];
    const connected = Boolean(c.applied || (c.exists && !c.changed));
    if (c.error) {
      return c.applied
        ? { text: t('已接入', 'Connected'), cls: 'wb-tag-ok' }
        : { text: c.installed ? t('已安装，尚未接入', 'Installed, not connected') : t('未检测到该客户端', 'Not detected'), cls: '' };
    }
    if (c.mode === 'native' && c.canSwitchBack) return { text: t('已切回原始模型', 'Using native models'), cls: 'wb-tag-info' };
    if (c.applied && c.changed) return { text: t('已接入，需重新写入', 'Connected · needs rewrite'), cls: 'wb-tag-warn' };
    if (connected && v?.state === 'done' && !v.result?.ok) return { text: t('已接入，验证未通过', 'Connected · check failed'), cls: 'wb-tag-fail' };
    if (connected) return { text: c.applied ? t('已接入', 'Connected') : t('已接入（非本控制台写入）', 'Connected (external)'), cls: 'wb-tag-ok' };
    return { text: c.installed ? t('已安装，尚未接入', 'Installed, not connected') : t('未检测到该客户端', 'Not detected'), cls: '' };
  };

  // Manual config generators
  const manualAvailableModels = useMemo(() => {
    if (catalog.length > 0) {
      return catalog.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: Number(m.context_window) || 200000,
        maxOutput: Number(m.max_output_tokens) || 16384,
      }));
    }
    return (clients?.modelDetails || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context || 200000,
      maxOutput: m.maxOutput || 16384,
    }));
  }, [catalog, clients?.modelDetails]);

  const activeManualIds = useMemo(() => {
    if (manualSelectedModels !== null) return manualSelectedModels;
    return clients?.models?.length ? clients.models : manualAvailableModels.slice(0, 4).map((m) => m.id);
  }, [clients?.models, manualAvailableModels, manualSelectedModels]);

  const activeManualModels = useMemo(() => {
    const set = new Set(activeManualIds);
    return manualAvailableModels.filter((m) => set.has(m.id));
  }, [activeManualIds, manualAvailableModels]);

  const generateOpencodeJson = (d: ClientsResponse) => {
    const modelsObj: Record<string, { name: string; limit: { context: number; output: number } }> = {};
    for (const m of activeManualModels) {
      modelsObj[m.id] = { name: m.name, limit: { context: m.context, output: m.maxOutput } };
    }
    return JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          workbuddy: {
            npm: '@ai-sdk/openai-compatible',
            name: 'WorkBuddy (local bridge)',
            options: { baseURL: d.baseUrlOpenAI, apiKey: d.token },
            models: modelsObj,
          },
        },
      },
      null,
      2,
    );
  };

  const generateClaudeSnippet = (d: ClientsResponse) =>
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: d.baseUrlAnthropic,
          ANTHROPIC_API_KEY: d.token,
          ANTHROPIC_MODEL: d.anthropicModel,
          ANTHROPIC_SMALL_FAST_MODEL: d.anthropicFastModel,
        },
      },
      null,
      2,
    );

  const generateCodexSnippet = (d: ClientsResponse) =>
    [
      'model_provider = "workbuddy"',
      `model = "${d.responsesModel || 'glm-5.3'}"`,
      '',
      '[model_providers.workbuddy]',
      'name = "WorkBuddy (local bridge)"',
      `base_url = "${d.baseUrlOpenAI}"`,
      'wire_api = "responses"',
      `experimental_bearer_token = "${d.token}"`,
    ].join('\n');

  const handleCopyAllCheatSheet = async () => {
    if (!clients) return;
    const text = [
      `# WorkBuddy Local API Bridge`,
      `OpenAI Base URL: ${clients.baseUrlOpenAI}`,
      `Anthropic Base URL: ${clients.baseUrlAnthropic}`,
      `API Key / Token: ${clients.token}`,
      `Anthropic Mapping: ${clients.anthropicModel} (fast: ${clients.anthropicFastModel})`,
      `Responses Mapping: ${clients.responsesModel} (fast: ${clients.responsesFastModel})`,
      `Models: ${activeManualIds.join(', ')}`,
    ].join('\n');
    const ok = await copyToClipboard(text);
    setMsg(ok ? t('已复制客户端接入速查表。', 'Client setup cheat sheet copied.') : t('复制失败', 'Copy failed'), ok ? 'good' : 'err');
  };

  return (
    <Panel
      section="clients"
      title={t('客户端接入', 'Client setup')}
      subtitle={t('支持 OpenAI / Anthropic / Responses 三套协议，一键写入配置或复制片段', 'OpenAI, Anthropic & Responses protocols — one-click config writer or manual copy studio')}
      icon={<Link2 className="h-4 w-4" />}
      stamp={clientsStamp ? t(`更新于 ${clientsStamp}`, `Updated ${clientsStamp}`) : undefined}
      stampId="clientsStamp"
      actions={
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => void loadConnect()} className="wb-btn wb-btn-sm">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('重新检测', 'Re-detect')}
          </button>
          <button type="button" id="clientsCopyAllBtn" disabled={!clients} onClick={() => void handleCopyAllCheatSheet()} className="wb-btn wb-btn-sm">
            <Copy className="h-3.5 w-3.5" />
            {t('复制全部', 'Copy all')}
          </button>
        </div>
      }
    >
      <div id="clientsBox" className="space-y-5">
        {/* ── 1. One-Click Auto-Connect Section ── */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4" style={{ color: 'var(--primary-text)' }} />
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
                {t('一键接入', 'One-click connect')}
              </h3>
              <span className="wb-tag wb-tag-ok">{t('自动备份 · 可撤销', 'Auto-backup · Reversible')}</span>
            </div>
            {connect?.backupDir && (
              <span className="text-[11.5px] mono truncate max-w-[340px]" title={connect.backupDir} style={{ color: 'var(--faint)' }}>
                {t('备份目录：', 'Backups: ')}{connect.backupDir}
              </span>
            )}
          </div>

          {connectError && !connect ? (
            <div className="rounded-xl p-4 flex flex-wrap items-center justify-between gap-3" style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}>
              <div className="text-[12.5px] font-medium">{connectError.message}</div>
              <button type="button" onClick={() => void loadConnect()} className="wb-btn wb-btn-sm">
                {t('重试', 'Retry')}
              </button>
            </div>
          ) : !connect ? (
            <SkeletonBlock lines={3} />
          ) : (
            <>
              {!connect.running && (
                <div className="rounded-xl px-3.5 py-2.5 text-[12.5px] flex items-center gap-2" style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn-border)', color: 'var(--warn)' }}>
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    {connect.bridge?.up && connect.bridge?.authRejected
                      ? t('桥正在运行但拒绝了当前令牌（401），请重启桥以同步令牌后再写入。', 'Bridge is up but rejected the token (401). Restart the bridge to sync tokens.')
                      : t('桥当前未运行；候选模型清单可能已过期，建议先启动桥。', 'Bridge is stopped; model options may be stale. Start the bridge first.')}
                  </span>
                </div>
              )}

              <div className="space-y-2.5">
                {connect.clients.map((c) => {
                  const st = getRowStatus(c);
                  const isOpen = openClientId === c.id;
                  const isBusy = busyClientId === c.id;
                  const curModels = savedSel.models[c.id]?.length ? savedSel.models[c.id] : c.effectiveModels || c.models || [];
                  const curPrimary = savedSel.model[c.id] || c.effectiveModel || curModels[0] || '';
                  const vState = verifyMap[c.id];
                  const opRes = opResultMap[c.id];
                  const connected = Boolean(c.applied || (c.exists && !c.changed));
                  const filterQ = (modelFilterByClient[c.id] || '').trim().toLowerCase();
                  const opts = (connect.modelOptions || []).filter(
                    (o) => !filterQ || o.id.toLowerCase().includes(filterQ) || (o.name || '').toLowerCase().includes(filterQ),
                  );

                  return (
                    <div
                      key={c.id}
                      className="rounded-xl overflow-hidden transition-colors"
                      style={{
                        background: 'var(--surface-subtle)',
                        border: `1px solid ${isOpen ? 'var(--primary-border)' : 'var(--border)'}`,
                      }}
                    >
                      {/* Client Row Summary */}
                      <div className="p-3.5 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-[14px]" style={{ color: 'var(--text)' }}>
                              {c.label}
                            </span>
                            <span className={`wb-tag ${st.cls}`}>{st.text}</span>
                            {!c.e2e && <span className="wb-tag">{t('本机未实测', 'Not E2E tested locally')}</span>}
                            <span className="wb-tag wb-tag-primary">
                              {t(`${curModels.length} 个模型`, `${curModels.length} models`)}
                            </span>
                          </div>
                          <div className="text-[11.5px] mono truncate" title={c.path} style={{ color: 'var(--muted)' }}>
                            {c.path}
                            {c.pathSource?.envName && (
                              <span className="ml-2 font-sans" style={{ color: 'var(--info)' }}>
                                · {t(`跟随 ${c.pathSource.envName}`, `via ${c.pathSource.envName}`)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={isBusy || Boolean(c.error)}
                            onClick={() => void handleApply(c)}
                            className="wb-btn wb-btn-primary wb-btn-sm"
                          >
                            {c.applied ? t('重新写入', 'Rewrite') : t('写入', 'Apply')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setOpenClientId(isOpen ? null : c.id)}
                            className="wb-btn wb-btn-sm"
                          >
                            <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
                            {isOpen ? t('收起详情', 'Hide') : t('详情', 'Details')}
                          </button>
                        </div>
                      </div>

                      {/* Smoothly Expanded Client Detail Drawer */}
                      <Collapse open={isOpen} unmountOnExit>
                        <div className="px-4 pb-4 pt-3 space-y-4" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
                          {/* Mode Switch + Verify + Undo Toolbar */}
                          <div className="flex flex-wrap items-center gap-2">
                            {c.canSwitchBack && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleModeSwitch(c, c.mode === 'native' ? 'bridge' : 'native')}
                                className="wb-btn wb-btn-sm"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {c.mode === 'native' ? t('切到桥的模型', 'Switch to bridge') : t('切回原始模型', 'Switch to native')}
                              </button>
                            )}
                            {connected && (
                              <button
                                type="button"
                                disabled={vState?.state === 'loading'}
                                onClick={() => void runVerify(c.id, false)}
                                className="wb-btn wb-btn-sm"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                                {vState?.state === 'loading' ? t('验证中…', 'Verifying…') : t('验证接入', 'Verify')}
                              </button>
                            )}
                            {c.applied && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleUndo(c)}
                                className="wb-btn wb-btn-danger wb-btn-sm ml-auto"
                              >
                                {t('撤销接入', 'Undo')}
                              </button>
                            )}
                          </div>

                          {/* Verify Verdict */}
                          {vState?.state === 'done' && vState.result && (
                            <div
                              className="rounded-xl px-3.5 py-2.5 text-[12px] space-y-1"
                              style={{
                                background: vState.result.ok ? 'var(--ok-soft)' : 'var(--fail-soft)',
                                border: `1px solid ${vState.result.ok ? 'var(--ok-border)' : 'var(--fail-border)'}`,
                                color: vState.result.ok ? 'var(--ok)' : 'var(--fail)',
                              }}
                            >
                              <div className="font-semibold flex items-center gap-1.5">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                {vState.result.ok ? t('静态配置与桥鉴权全部通过', 'Static config & live bridge auth passed') : t('接入验证未通过', 'Verification failed')}
                              </div>
                              {vState.result.written?.issues?.map((iss, i) => (
                                <div key={i}>· {iss}</div>
                              ))}
                              {vState.result.auth && !vState.result.auth.ok && (
                                <div>· {t('桥鉴权：', 'Bridge auth: ')}{vState.result.auth.error || `HTTP ${vState.result.auth.status}`}</div>
                              )}
                            </div>
                          )}

                          {/* Operation Result Log */}
                          {opRes && (
                            <div
                              className="rounded-xl px-3.5 py-2.5 text-[12px] space-y-1"
                              style={{
                                background: opRes.ok ? 'var(--ok-soft)' : 'var(--fail-soft)',
                                border: `1px solid ${opRes.ok ? 'var(--ok-border)' : 'var(--fail-border)'}`,
                                color: opRes.ok ? 'var(--ok)' : 'var(--fail)',
                              }}
                            >
                              {opRes.lines.map((ln, i) => (
                                <div key={i} className="break-all">{ln}</div>
                              ))}
                            </div>
                          )}

                          {/* Codex Zero-Write Profile Channel */}
                          {c.profile && (
                            <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>
                                    {t('零侵入 Profile 通道（仅 CLI）', 'Zero-write Profile Channel (CLI only)')}
                                  </div>
                                  <div className="text-[11.5px] mono" style={{ color: 'var(--muted)' }}>
                                    {c.profile.launch} · {c.profile.path}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <button type="button" disabled={isBusy} onClick={() => void handleProfileAction(c, 'apply')} className="wb-btn wb-btn-sm">
                                    {t('写入 profile 文件', 'Write profile')}
                                  </button>
                                  {c.profile.applied && (
                                    <button type="button" disabled={isBusy} onClick={() => void handleProfileAction(c, 'undo')} className="wb-btn wb-btn-danger wb-btn-sm">
                                      {t('删除 profile 文件', 'Delete profile')}
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
                                {t('不改动主 config.toml；注意桌面版 App 不支持命令行 -p 参数。', 'Leaves main config.toml untouched; note desktop App ignores CLI -p flags.')}
                              </div>
                            </div>
                          )}

                          {/* Searchable Multi-Model Checklist */}
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>
                                {t('选择要写入的模型（★ 设为默认主模型）', 'Select models to write (★ = primary default)')}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value={modelFilterByClient[c.id] || ''}
                                  onChange={(e) => setModelFilterByClient((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                  placeholder={t('筛选模型…', 'Filter…')}
                                  className="wb-input wb-input-sm w-36"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateSavedSel({
                                      ...savedSel,
                                      models: { ...savedSel.models, [c.id]: (connect.modelOptions || []).map((o) => o.id) },
                                    })
                                  }
                                  className="wb-btn wb-btn-sm"
                                >
                                  {t('全选', 'All')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const nextM = { ...savedSel.models };
                                    const nextP = { ...savedSel.model };
                                    delete nextM[c.id];
                                    delete nextP[c.id];
                                    updateSavedSel({ models: nextM, model: nextP });
                                  }}
                                  className="wb-btn wb-btn-sm"
                                >
                                  {t('用精选集', 'Curated')}
                                </button>
                              </div>
                            </div>
                            <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 p-2 rounded-xl" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
                              {opts.map((opt) => {
                                const checked = curModels.includes(opt.id);
                                const isMain = curPrimary === opt.id;
                                return (
                                  <div
                                    key={opt.id}
                                    className="flex items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px]"
                                    style={{
                                      background: checked ? 'var(--surface)' : 'transparent',
                                      border: `1px solid ${checked ? 'var(--primary-border)' : 'transparent'}`,
                                    }}
                                  >
                                    <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={(e) => {
                                          let nextList = e.target.checked
                                            ? [...new Set([...curModels, opt.id])]
                                            : curModels.filter((x) => x !== opt.id);
                                          if (nextList.length === 0) return; // enforce min 1 model
                                          const nextPrimary = nextList.includes(curPrimary) ? curPrimary : nextList[0];
                                          updateSavedSel({
                                            models: { ...savedSel.models, [c.id]: nextList },
                                            model: { ...savedSel.model, [c.id]: nextPrimary },
                                          });
                                        }}
                                        className="accent-[var(--primary)]"
                                      />
                                      <span className="mono truncate">{opt.id}</span>
                                    </label>
                                    <button
                                      type="button"
                                      title={t('设为默认主模型', 'Set as primary default')}
                                      aria-label={t(`将 ${opt.id} 设为默认`, `Set ${opt.id} as primary`)}
                                      onClick={() => {
                                        const nextList = curModels.includes(opt.id) ? curModels : [...curModels, opt.id];
                                        updateSavedSel({
                                          models: { ...savedSel.models, [c.id]: nextList },
                                          model: { ...savedSel.model, [c.id]: opt.id },
                                        });
                                      }}
                                      className="cursor-pointer shrink-0"
                                      style={{ color: isMain ? 'var(--warn-dot)' : 'var(--faint)' }}
                                    >
                                      <Star className="h-3.5 w-3.5" fill={isMain ? 'currentColor' : 'none'} />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Diff Changes + Full Preview */}
                          {(c.changes?.length || 0) > 0 && (
                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>
                                {t('将要修改的配置项', 'Planned config changes')}
                              </div>
                              <div className="rounded-xl p-3 space-y-1 text-[12px] mono" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
                                {c.changes!.map((ch, i) => (
                                  <div key={i} className="flex flex-wrap items-center gap-2">
                                    <span className="font-semibold" style={{ color: 'var(--primary-text)' }}>{ch.path}</span>
                                    <span style={{ color: 'var(--muted)' }}>
                                      {ch.from == null ? t('新增', 'add') : String(ch.from)} → <strong style={{ color: 'var(--ok)' }}>{String(ch.to)}</strong>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {c.catalog?.path && (
                            <div className="text-[11.5px] mono" style={{ color: 'var(--muted)' }}>
                              {t('另外会写一份模型目录：', 'Additional model catalog file: ')}{c.catalog.path}
                            </div>
                          )}

                          {c.preview && (
                            <AnimatedDetails
                              open={Boolean(previewOpenByClient[c.id])}
                              onOpenChange={(next) => setPreviewOpenByClient((prev) => ({ ...prev, [c.id]: next }))}
                              className="rounded-xl overflow-hidden"
                              style={{ border: '1px solid var(--border)' }}
                              summaryClassName="px-3 py-2 flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer select-none"
                              summaryStyle={{ background: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}
                              summary={
                                <>
                                  <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${previewOpenByClient[c.id] ? 'rotate-90' : ''}`} />
                                  <span>{t('预览写入后的完整文件内容', 'Preview full config file')}</span>
                                </>
                              }
                            >
                              <pre
                                data-i18n-skip=""
                                className="p-3 text-[11.5px] overflow-x-auto max-h-60"
                                style={{ background: '#0a0b0f', color: '#d4d8e2' }}
                              >
                                {c.preview}
                              </pre>
                            </AnimatedDetails>
                          )}
                        </div>
                      </Collapse>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ── 2. Smoothly Animated Manual Copy Studio ── */}
        <AnimatedDetails
          open={manualOpen}
          onOpenChange={setManualOpen}
          className="manualconnect rounded-xl overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-subtle)' }}
          summaryClassName="px-4 py-3 flex items-center justify-between cursor-pointer select-none"
          summary={
            <>
              <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold" style={{ color: 'var(--text)' }}>
                <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${manualOpen ? 'rotate-90' : ''}`} style={{ color: 'var(--muted)' }} />
                <Code2 className="h-4 w-4" style={{ color: 'var(--primary-text)' }} />
                <span>{t('手动接入（复制片段与逐字段表单指引）', 'Manual setup (Copy snippets & field-by-field form guide)')}</span>
              </span>
              <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                {t('三个接入值 · 配置片段 · 兼容性分档', 'Endpoints · Snippets · Compatibility')}
              </span>
            </>
          }
        >

          <div className="p-4 space-y-4" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
            {!clients ? (
              <SkeletonBlock lines={3} />
            ) : (
              <>
                {/* 3 Core Copyable Endpoint Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[
                    { label: t('OpenAI Base URL（通用）', 'OpenAI Base URL'), value: clients.baseUrlOpenAI, hint: t('必须带 /v1 结尾', 'Must end with /v1') },
                    { label: t('Anthropic Base URL（Claude Code）', 'Anthropic Base URL'), value: clients.baseUrlAnthropic, hint: t('不要加 /v1', 'Do not append /v1') },
                    { label: t('本地 API 令牌（API Key）', 'Local API Token'), value: clients.token, hint: t('仅用于本机回环鉴权', 'Local loopback auth only') },
                  ].map((item) => (
                    <div key={item.label} className="rounded-xl p-3 space-y-1.5" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>{item.label}</span>
                        <CopyButton text={item.value} label={item.label} size="sm" />
                      </div>
                      <code className="block text-[12px] font-semibold break-all" style={{ color: 'var(--text)' }}>
                        {item.value}
                      </code>
                      <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{item.hint}</div>
                    </div>
                  ))}
                </div>

                {/* Smooth Sliding Segmented Client Picker */}
                <SegmentedControl
                  value={manualTab}
                  ariaLabel={t('客户端类型', 'Client type')}
                  className="clientpicker flex-wrap"
                  onChange={(v) => setManualTab(v as ManualTab)}
                  options={[
                    { value: 'opencode', label: 'opencode', buttonClassName: 'clientchip' },
                    { value: 'claude', label: 'Claude Code', buttonClassName: 'clientchip' },
                    { value: 'codex', label: 'Codex', buttonClassName: 'clientchip' },
                    { value: 'form', label: t('图形表单', 'GUI Form'), buttonClassName: 'clientchip' },
                    { value: 'other', label: t('其它客户端', 'Other clients'), buttonClassName: 'clientchip' },
                  ]}
                />

                {/* Model Chip Selector (for opencode & form) */}
                {(manualTab === 'opencode' || manualTab === 'form') && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span style={{ color: 'var(--muted)' }}>
                        {t(`勾选要生成的模型（已选 ${activeManualIds.length} 个）：`, `Select models to include (${activeManualIds.length} selected):`)}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setManualSelectedModels(manualAvailableModels.map((m) => m.id))}
                          className="wb-btn wb-btn-sm"
                        >
                          {t('全选', 'All')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualSelectedModels(clients.models || [])}
                          className="wb-btn wb-btn-sm"
                        >
                          {t('精选集', 'Curated')}
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {manualAvailableModels.map((m) => {
                        const on = activeManualIds.includes(m.id);
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setManualSelectedModels(
                                on ? activeManualIds.filter((x) => x !== m.id) : [...activeManualIds, m.id],
                              )
                            }
                            className={`modelpick-chip inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold mono cursor-pointer transition-colors ${on ? 'on' : ''}`}
                            style={{
                              background: on ? 'var(--primary-soft)' : 'var(--surface-subtle)',
                              color: on ? 'var(--primary-text)' : 'var(--muted)',
                              border: `1px solid ${on ? 'var(--primary-border)' : 'var(--border)'}`,
                            }}
                          >
                            {on && <Check className="h-3 w-3" />}
                            <span>{m.id}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Tab Content */}
                {manualTab === 'opencode' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[12.5px] font-semibold mono">opencode.json</span>
                      <CopyButton text={generateOpencodeJson(clients)} label="opencode.json" />
                    </div>
                    <pre data-i18n-skip="" className="rounded-xl p-3.5 text-[12px] overflow-x-auto" style={{ background: '#0a0b0f', color: '#d4d8e2' }}>
                      {generateOpencodeJson(clients)}
                    </pre>
                  </div>
                )}

                {manualTab === 'claude' && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold">
                        ~/.claude/settings.json
                        <span className="ml-2 font-normal text-[12px]" style={{ color: 'var(--muted)' }}>
                          ({t(`映射：${clients.anthropicModel} / 快速：${clients.anthropicFastModel}`, `Mapped: ${clients.anthropicModel} / fast: ${clients.anthropicFastModel}`)})
                        </span>
                      </span>
                      <CopyButton text={generateClaudeSnippet(clients)} label="Claude Code settings.json" />
                    </div>
                    <pre data-i18n-skip="" className="rounded-xl p-3.5 text-[12px] overflow-x-auto" style={{ background: '#0a0b0f', color: '#d4d8e2' }}>
                      {generateClaudeSnippet(clients)}
                    </pre>
                  </div>
                )}

                {manualTab === 'codex' && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold flex items-center gap-1.5">
                        <Terminal className="h-3.5 w-3.5" />
                        ~/.codex/config.toml
                      </span>
                      <CopyButton text={generateCodexSnippet(clients)} label="Codex config.toml" />
                    </div>
                    <pre data-i18n-skip="" className="rounded-xl p-3.5 text-[12px] overflow-x-auto" style={{ background: '#0a0b0f', color: '#d4d8e2' }}>
                      {generateCodexSnippet(clients)}
                    </pre>
                  </div>
                )}

                {manualTab === 'form' && (
                  <div className="space-y-3">
                    <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                      {t('适用于 Cherry Studio / Chatbox / LobeChat 等「自定义提供商」图形表单，逐格复制即可：', 'For GUI clients with a Custom Provider form (Cherry Studio, Chatbox, etc.):')}
                    </p>
                    <div className="wb-table-wrap tablewrap">
                      <table className="wb-table">
                        <thead>
                          <tr>
                            <th>{t('字段名', 'Field')}</th>
                            <th>{t('取值', 'Value')}</th>
                            <th>{t('操作', 'Action')}</th>
                            <th>{t('说明', 'Note')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            { f: t('提供商 ID', 'Provider ID'), v: 'workbuddy', n: t('任意小写标识', 'Any lowercase id') },
                            { f: t('基础 URL', 'Base URL'), v: clients.baseUrlOpenAI, n: t('必须带 /v1 结尾', 'Must end with /v1') },
                            { f: t('API 密钥', 'API Key'), v: clients.token, n: t('本地回环令牌', 'Local bridge token') },
                            ...activeManualModels.flatMap((m) => [
                              { f: `${m.id} · ${t('上下文', 'Context')}`, v: String(m.context), n: t('留空会被客户端显示为 0', 'Leaving blank shows 0 in many UIs') },
                              { f: `${m.id} · ${t('最大输出', 'Max output')}`, v: String(m.maxOutput), n: m.name },
                            ]),
                          ].map((row, idx) => (
                            <tr key={idx}>
                              <td className="font-medium">{row.f}</td>
                              <td className="mono">{row.v}</td>
                              <td><CopyButton text={row.v} label={row.f} size="sm" /></td>
                              <td style={{ color: 'var(--muted)' }}>{row.n}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {manualTab === 'other' && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[
                      {
                        tier: t('已实测', 'Verified'),
                        cls: 'wb-tag-ok',
                        items: 'DeepSeek Harness (DSH), Codex CLI, opencode (@ai-sdk/openai-compatible), Claude Code',
                        note: t('已在桥侧实跑通过', 'Verified end-to-end against this bridge'),
                      },
                      {
                        tier: t('协议兼容', 'Protocol compatible'),
                        cls: 'wb-tag-info',
                        items: 'Cherry Studio, Cursor, Cline, Roo Code, Continue, Open WebUI, Chatbox',
                        note: t('只依赖 /v1/models 与 /v1/chat/completions；未逐个装机实测', 'Uses standard OpenAI endpoints; not individually installed & tested'),
                      },
                      {
                        tier: t('不支持', 'Unsupported'),
                        cls: 'wb-tag-fail',
                        items: en ? 'RAG / Vector Embeddings (/v1/embeddings → 501)' : 'RAG / 向量嵌入（/v1/embeddings 返回 501）',
                        note: t('上游未提供 embedding 模型，桥明确拒绝而不返回假向量', 'Upstream provides no embedding model; bridge refuses honestly with 501'),
                      },
                    ].map((card) => (
                      <div key={card.tier} className="rounded-xl p-3.5 space-y-2" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
                        <span className={`wb-tag ${card.cls}`}>{card.tier}</span>
                        <div className="text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>{card.items}</div>
                        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{card.note}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </AnimatedDetails>
      </div>
    </Panel>
  );
};
