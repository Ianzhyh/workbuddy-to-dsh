import React, { useEffect, useState } from 'react';
import { ConsoleShell } from './components/layout/ConsoleShell';
import { AccountsPanel } from './components/panels/AccountsPanel';
import { AlertsAndActions } from './components/panels/AlertsAndActions';
import { ChatPlaygroundPanel } from './components/panels/ChatPlaygroundPanel';
import { CheckinPanel } from './components/panels/CheckinPanel';
import { ClientsPanel } from './components/panels/ClientsPanel';
import { DiagnosticsPanel } from './components/panels/DiagnosticsPanel';
import { KpiCards } from './components/panels/KpiCards';
import { LimitsPanel } from './components/panels/LimitsPanel';
import { ModelsPanel } from './components/panels/ModelsPanel';
import { RequestsPanel } from './components/panels/RequestsPanel';
import { UsagePanel } from './components/panels/UsagePanel';
import { CommandPalette } from './components/ui/CommandPalette';
import { DialogProvider, useDialog } from './components/ui/Dialog';
import { FloatingToast } from './components/ui/Toast';
import { ConsoleProvider, useConsole } from './context/ConsoleContext';
import { api, copyToClipboard } from './lib/api';
import { I18nProvider, useI18n } from './lib/i18n';

const ConsoleWorkspace: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    theme,
    toggleTheme,
    overview,
    probeRunning,
    refreshAll,
    loadOverview,
    loadDiag,
    loadModels,
    actionMsg,
    setMsg,
    buildDiagReport,
  } = useConsole();
  const { t } = useI18n();
  const { confirmDangerous } = useDialog();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bridgeBusy, setBridgeBusy] = useState(false);

  // Global Cmd+K / Ctrl+K shortcut for Command Palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const probeNote = () =>
    probeRunning ? [t('体检进行中，停止桥会中断本轮体检。', 'A model probe is running and will be interrupted.')] : [];

  const handleStartBridge = async () => {
    setBridgeBusy(true);
    setMsg(t('正在启动桥服务…', 'Starting bridge…'));
    try {
      const d = await api<{ started?: boolean; reused?: boolean; pid?: number; error?: string; spawnError?: string }>(
        '/api/bridge/start',
        { method: 'POST', timeoutMs: 25_000 },
      );
      if (d.started) {
        const text = d.reused
          ? t(`桥已在运行（复用 PID ${d.pid ?? '—'}）`, `Bridge already running (reused PID ${d.pid ?? '—'})`)
          : t(`桥已启动（PID ${d.pid ?? '—'}）`, `Bridge started (PID ${d.pid ?? '—'})`);
        setMsg(text, 'good');
      } else {
        setMsg(t('启动失败：', 'Start failed: ') + (d.error || d.spawnError || t('未知原因', 'unknown reason')), 'err');
      }
      await Promise.all([loadOverview(), loadDiag(), loadModels()]);
    } finally {
      setBridgeBusy(false);
    }
  };

  const handleRestartBridge = async () => {
    const ok = await confirmDangerous(t('确定重启本地 API 桥？', 'Restart the local API bridge?'), probeNote());
    if (!ok) return;
    setBridgeBusy(true);
    setMsg(t('正在重启桥服务…', 'Restarting bridge…'));
    try {
      const d = await api<{ started?: boolean; reused?: boolean; pid?: number; error?: string }>(
        '/api/bridge/restart',
        { method: 'POST', timeoutMs: 30_000 },
      );
      if (d.started && d.reused) {
        setMsg(t(`桥仍在运行（PID ${d.pid ?? '—'}），本次未能完成重启`, `Bridge still running (PID ${d.pid ?? '—'}); restart did not complete`), 'err');
      } else if (d.started) {
        setMsg(t(`桥已重启（PID ${d.pid ?? '—'}）`, `Bridge restarted (PID ${d.pid ?? '—'})`), 'good');
      } else {
        setMsg(t('重启失败：', 'Restart failed: ') + (d.error || t('未知原因', 'unknown reason')), 'err');
      }
      await Promise.all([loadOverview(), loadDiag(), loadModels()]);
    } finally {
      setBridgeBusy(false);
    }
  };

  const handleStopBridge = async () => {
    const ok = await confirmDangerous(t('确定停止本地 API 桥？', 'Stop the local API bridge?'), probeNote());
    if (!ok) return;
    setBridgeBusy(true);
    setMsg(t('正在停止桥服务…', 'Stopping bridge…'));
    try {
      const d = await api<{ stopped?: boolean; pid?: number; error?: string; warning?: string }>(
        '/api/bridge/stop',
        { method: 'POST', timeoutMs: 25_000 },
      );
      if (d.stopped) {
        setMsg(t(`桥已停止${d.pid ? `（PID ${d.pid}）` : ''}`, `Bridge stopped${d.pid ? ` (PID ${d.pid})` : ''}`), 'good');
      } else {
        setMsg(t('停止失败：', 'Stop failed: ') + (d.error || d.warning || t('未知原因', 'unknown reason')), 'err');
      }
      await Promise.all([loadOverview(), loadDiag()]);
    } finally {
      setBridgeBusy(false);
    }
  };

  const show = (sec: 'overview' | 'models' | 'playground' | 'clients') =>
    activeTab === 'all' || activeTab === sec;

  const b = overview?.bridge;

  return (
    <>
      <ConsoleShell
        onOpenPalette={() => setPaletteOpen(true)}
        onStartBridge={() => void handleStartBridge()}
        onRestartBridge={() => void handleRestartBridge()}
        onStopBridge={() => void handleStopBridge()}
        bridgeBusy={bridgeBusy}
      >
        <AlertsAndActions
          onStartBridge={() => void handleStartBridge()}
          onRestartBridge={() => void handleRestartBridge()}
          onStopBridge={() => void handleStopBridge()}
          bridgeBusy={bridgeBusy}
        />

        {show('overview') && (
          <>
            <KpiCards />
            <AccountsPanel />
            <LimitsPanel />
            <UsagePanel />
            <CheckinPanel />
            <RequestsPanel />
          </>
        )}

        {show('models') && <ModelsPanel />}

        {show('clients') && <ClientsPanel />}

        {show('playground') && (
          <>
            <ChatPlaygroundPanel />
            <DiagnosticsPanel />
          </>
        )}
      </ConsoleShell>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectTab={setActiveTab}
        onStartBridge={() => void handleStartBridge()}
        onRestartBridge={() => void handleRestartBridge()}
        onStopBridge={() => void handleStopBridge()}
        onRefreshAll={() => void refreshAll()}
        onRunDiag={() => {
          setActiveTab('playground');
          void loadDiag();
        }}
        onCopyUrl={async () => {
          if (!b?.running || !b.endpoint) {
            setMsg(t('桥未运行，无法复制地址。', 'Bridge is not running; URL unavailable.'), 'err');
            return;
          }
          const url = b.endpoint.replace(/\/v1\/?$/, '') + '/v1';
          const ok = await copyToClipboard(url);
          setMsg(ok ? t(`已复制：${url}`, `Copied: ${url}`) : t('复制失败', 'Copy failed'), ok ? 'good' : 'err');
        }}
        onCopyReport={async () => {
          const ok = await copyToClipboard(buildDiagReport());
          setMsg(
            ok
              ? t('诊断报告已复制到剪贴板（不含任何令牌值）', 'Diagnostics report copied (contains no tokens)')
              : t('复制失败', 'Copy failed'),
            ok ? 'good' : 'err',
          );
        }}
        onToggleTheme={toggleTheme}
        theme={theme}
        bridgeRunning={Boolean(b?.running)}
        bridgeOk={Boolean(b?.ok)}
      />

      <FloatingToast message={actionMsg} />
    </>
  );
};

export const App: React.FC = () => (
  <I18nProvider>
    <DialogProvider>
      <ConsoleProvider>
        <ConsoleWorkspace />
      </ConsoleProvider>
    </DialogProvider>
  </I18nProvider>
);

export default App;
