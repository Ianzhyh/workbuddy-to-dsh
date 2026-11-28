import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CornerDownLeft,
  Cpu,
  FileText,
  Languages,
  LayoutGrid,
  Link2,
  MessageSquare,
  Moon,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  Square,
  Stethoscope,
  Sun,
} from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import type { NavTab } from '../../types/api';

export interface CommandItem {
  id: string;
  group: string;
  label: string;
  keywords: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelectTab: (tab: NavTab) => void;
  onStartBridge: () => void;
  onRestartBridge: () => void;
  onStopBridge: () => void;
  onRefreshAll: () => void;
  onRunDiag: () => void;
  onCopyUrl: () => void;
  onCopyReport: () => void;
  onToggleTheme: () => void;
  theme: 'light' | 'dark';
  bridgeRunning: boolean;
  bridgeOk: boolean;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onSelectTab,
  onStartBridge,
  onRestartBridge,
  onStopBridge,
  onRefreshAll,
  onRunDiag,
  onCopyUrl,
  onCopyReport,
  onToggleTheme,
  theme,
  bridgeRunning,
  bridgeOk,
}) => {
  const { t, toggleLang } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = useMemo<CommandItem[]>(() => {
    const navGroup = t('页面导航', 'Navigation');
    const actGroup = t('桥与快捷操作', 'Bridge & Actions');
    const prefGroup = t('界面偏好', 'Preferences');

    return [
      { id: 'tab-overview', group: navGroup, label: t('概览与用量', 'Overview & usage'), keywords: 'overview usage accounts dashboard 总览 概览 用量 账号', icon: <Activity className="h-4 w-4" />, action: () => onSelectTab('overview') },
      { id: 'tab-all', group: navGroup, label: t('全部面板', 'All panels'), keywords: 'all panels 全部 面板', icon: <LayoutGrid className="h-4 w-4" />, action: () => onSelectTab('all') },
      { id: 'tab-models', group: navGroup, label: t('可用模型', 'Available models'), keywords: 'models catalog probe speed tps 模型 目录 测速 体检', icon: <Cpu className="h-4 w-4" />, action: () => onSelectTab('models') },
      { id: 'tab-playground', group: navGroup, label: t('对话测试与诊断', 'Chat test & diagnostics'), keywords: 'chat playground diagnostics logs 对话 测试 诊断 日志', icon: <MessageSquare className="h-4 w-4" />, action: () => onSelectTab('playground') },
      { id: 'tab-clients', group: navGroup, label: t('客户端接入', 'Client setup'), keywords: 'clients connect codex claude opencode 客户端 接入 配置', icon: <Link2 className="h-4 w-4" />, action: () => onSelectTab('clients') },

      { id: 'act-refresh', group: actGroup, label: t('刷新全部面板', 'Refresh all panels'), keywords: 'refresh reload 刷新', icon: <RefreshCw className="h-4 w-4" />, action: onRefreshAll },
      ...(!bridgeOk ? [{ id: 'act-start', group: actGroup, label: t('启动桥服务', 'Start bridge'), keywords: 'start bridge 启动 桥', icon: <Play className="h-4 w-4" />, action: onStartBridge }] : []),
      { id: 'act-restart', group: actGroup, label: t('重启桥服务', 'Restart bridge'), keywords: 'restart bridge 重启 桥', icon: <RotateCw className="h-4 w-4" />, action: onRestartBridge },
      ...(bridgeRunning ? [{ id: 'act-stop', group: actGroup, label: t('停止桥服务', 'Stop bridge'), keywords: 'stop bridge 停止 桥', icon: <Square className="h-4 w-4" />, action: onStopBridge }] : []),
      { id: 'act-diag', group: actGroup, label: t('重新运行环境诊断', 'Re-run environment diagnostics'), keywords: 'diagnose check 诊断 检查', icon: <Stethoscope className="h-4 w-4" />, action: onRunDiag },
      { id: 'act-url', group: actGroup, label: t('复制桥 API 地址', 'Copy bridge API URL'), keywords: 'copy url endpoint 复制 地址', icon: <Sparkles className="h-4 w-4" />, action: onCopyUrl },
      { id: 'act-report', group: actGroup, label: t('复制诊断报告 (Markdown)', 'Copy diagnostics report (Markdown)'), keywords: 'copy report markdown 复制 诊断 报告', icon: <FileText className="h-4 w-4" />, action: onCopyReport },

      { id: 'pref-theme', group: prefGroup, label: theme === 'dark' ? t('切换到浅色模式', 'Switch to Light Mode') : t('切换到深色模式', 'Switch to Dark Mode'), keywords: 'theme dark light 主题 深色 浅色', icon: theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />, action: onToggleTheme },
      { id: 'pref-lang', group: prefGroup, label: t('切换语言 (中文 / English)', 'Switch language (EN / 中文)'), keywords: 'language english chinese i18n 语言 英文 中文', icon: <Languages className="h-4 w-4" />, action: toggleLang },
    ];
  }, [bridgeOk, bridgeRunning, onCopyReport, onCopyUrl, onRefreshAll, onRestartBridge, onRunDiag, onSelectTab, onStartBridge, onStopBridge, onToggleTheme, t, theme, toggleLang]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q) || item.keywords.toLowerCase().includes(q));
  }, [items, query]);

  const runItem = useCallback((item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    item.action();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      setQuery('');
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return undefined;
    }
    if (!rendered) return undefined;
    setClosing(true);
    const id = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, 165);
    return () => clearTimeout(id);
  }, [open, rendered]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Global keyboard handling when palette is open so Escape ALWAYS closes reliably
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(filtered[activeIdx]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIdx, filtered, onClose, open, runItem]);

  if (!rendered) return null;

  return (
    <div
      className={`fixed inset-0 flex items-start justify-center pt-[13vh] px-4 ${closing ? 'wb-backdrop-out pointer-events-none' : 'wb-backdrop-in'}`}
      style={{
        zIndex: 'var(--z-modal)',
        background: 'rgba(0, 0, 0, 0.44)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('命令面板', 'Command palette')}
        className={`wb-popover w-full max-w-[540px] overflow-hidden rounded-[16px] ${closing ? 'wb-modal-out' : 'wb-modal-in'}`}
      >
        <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid var(--border)' }}>
          <Search className="h-[17px] w-[17px] shrink-0" style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('输入命令、页面名称或操作…', 'Type a command, view, or action…')}
            className="wb-palette-input w-full bg-transparent text-[14.5px] font-normal outline-none"
            style={{ color: 'var(--text)' }}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('关闭命令面板', 'Close command palette')}
            className="mono shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer"
            style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            ESC
          </button>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2 space-y-0.5">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
              {t('没有匹配的命令', 'No matching commands')}
            </div>
          ) : (
            filtered.map((item, idx) => {
              const active = idx === activeIdx;
              const prevGroup = idx > 0 ? filtered[idx - 1].group : '';
              return (
                <React.Fragment key={item.id}>
                  {item.group !== prevGroup && (
                    <div className="px-2.5 pt-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--faint)' }}>
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => runItem(item)}
                    className="flex w-full items-center justify-between rounded-[9px] px-3 py-2 text-left text-[13px] transition-colors duration-100 cursor-pointer"
                    style={{
                      background: active ? 'var(--surface-hover)' : 'transparent',
                      color: active ? 'var(--text)' : 'var(--text-secondary)',
                    }}
                  >
                    <span className="flex items-center gap-2.5">
                      <span style={{ color: active ? 'var(--primary)' : 'var(--muted)' }}>{item.icon}</span>
                      <span className={active ? 'font-semibold' : 'font-medium'}>{item.label}</span>
                    </span>
                    {active && <CornerDownLeft className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>

        {/* Subtle Keyboard Shortcut Footer */}
        <div
          className="flex items-center justify-between px-4 py-2 text-[11px]"
          style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-tint)', color: 'var(--faint)' }}
        >
          <span>{t('↑↓ 导航 · ↵ 执行', '↑↓ Navigate · ↵ Run')}</span>
          <span className="mono">⌘K</span>
        </div>
      </div>
    </div>
  );
};
