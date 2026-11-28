import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowUp,
  Check,
  Cpu,
  LayoutGrid,
  Link2,
  Menu,
  MessageSquare,
  Moon,
  Palette,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Sun,
  X,
} from 'lucide-react';
import { ACCENT_PRESETS, useConsole } from '../../context/ConsoleContext';
import { fmtUptime } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { NavTab } from '../../types/api';

interface ConsoleShellProps {
  onOpenPalette: () => void;
  onStartBridge: () => void;
  onRestartBridge: () => void;
  onStopBridge: () => void;
  bridgeBusy: boolean;
  children: React.ReactNode;
}

export const ConsoleShell: React.FC<ConsoleShellProps> = ({
  onOpenPalette,
  onStartBridge,
  onRestartBridge,
  onStopBridge,
  bridgeBusy,
  children,
}) => {
  const {
    activeTab,
    setActiveTab,
    theme,
    toggleTheme,
    accent,
    setAccent,
    overview,
    overviewStamp,
    models,
    limits,
    diagnose,
    refreshingAll,
    refreshAll,
    liveAnnouncement,
    countNewFailures,
  } = useConsole();
  const { en, t, toggleLang } = useI18n();

  const [accentOpen, setAccentOpen] = useState(false);
  const [accentRendered, setAccentRendered] = useState(false);
  const [accentClosing, setAccentClosing] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileNavRendered, setMobileNavRendered] = useState(false);
  const [mobileNavClosing, setMobileNavClosing] = useState(false);
  const [showBackTop, setShowBackTop] = useState(false);
  const [backTopRendered, setBackTopRendered] = useState(false);
  const accentWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (accentOpen) {
      setAccentRendered(true);
      setAccentClosing(false);
      return undefined;
    }
    if (!accentRendered) return undefined;
    setAccentClosing(true);
    const id = window.setTimeout(() => {
      setAccentRendered(false);
      setAccentClosing(false);
    }, 150);
    return () => clearTimeout(id);
  }, [accentOpen, accentRendered]);

  useEffect(() => {
    if (mobileNavOpen) {
      setMobileNavRendered(true);
      setMobileNavClosing(false);
      return undefined;
    }
    if (!mobileNavRendered) return undefined;
    setMobileNavClosing(true);
    const id = window.setTimeout(() => {
      setMobileNavRendered(false);
      setMobileNavClosing(false);
    }, 205);
    return () => clearTimeout(id);
  }, [mobileNavOpen, mobileNavRendered]);

  useEffect(() => {
    if (showBackTop) {
      setBackTopRendered(true);
      return undefined;
    }
    if (!backTopRendered) return undefined;
    const id = window.setTimeout(() => setBackTopRendered(false), 205);
    return () => clearTimeout(id);
  }, [backTopRendered, showBackTop]);

  useEffect(() => {
    const onScroll = () => setShowBackTop(window.scrollY > 280);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!accentOpen) return;
    const onClick = (e: MouseEvent) => {
      if (accentWrapRef.current && !accentWrapRef.current.contains(e.target as Node)) {
        setAccentOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccentOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [accentOpen]);

  const b = overview?.bridge;
  const badgeState: 'loading' | 'ok' | 'warn' | 'fail' = !overview
    ? 'loading'
    : overview.error
      ? 'fail'
      : b?.ok
        ? 'ok'
        : b?.running
          ? 'warn'
          : 'fail';

  const badgeLabel =
    badgeState === 'loading'
      ? t('检测中', 'Checking')
      : overview?.error
        ? t('控制台异常', 'Console error')
        : badgeState === 'ok'
          ? t('桥运行中', 'Bridge running')
          : badgeState === 'warn'
            ? t('桥有响应但异常', 'Responds but unhealthy')
            : t('桥未运行', 'Bridge not running');

  const badgeStyle =
    badgeState === 'ok'
      ? { bg: 'var(--ok-soft)', fg: 'var(--ok)', border: 'var(--ok-border)', dot: 'var(--ok-dot)' }
      : badgeState === 'warn'
        ? { bg: 'var(--warn-soft)', fg: 'var(--warn)', border: 'var(--warn-border)', dot: 'var(--warn-dot)' }
        : badgeState === 'fail'
          ? { bg: 'var(--fail-soft)', fg: 'var(--fail)', border: 'var(--fail-border)', dot: 'var(--fail-dot)' }
          : { bg: 'var(--surface-subtle)', fg: 'var(--muted)', border: 'var(--border)', dot: 'var(--faint)' };

  const activeLimitCount = (limits?.limiting || []).filter((it) => {
    if (!it.resetAt) return true;
    const ms = Date.parse(it.resetAt);
    return !Number.isFinite(ms) || ms > Date.now();
  }).length;
  const diagFailCount = diagnose?.summary?.fail || 0;
  const newFailCount = countNewFailures();
  const modelCount = models?.models?.length ?? b?.catalogSize ?? null;

  const navItems: Array<{
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: string | number | null;
    badgeTone?: 'warn' | 'fail' | 'neutral';
  }> = [
    {
      id: 'all',
      label: t('全部面板', 'All panels'),
      icon: <LayoutGrid className="h-[15px] w-[15px]" strokeWidth={1.8} />,
    },
    {
      id: 'overview',
      label: t('概览与用量', 'Overview & usage'),
      icon: <Activity className="h-[15px] w-[15px]" strokeWidth={1.8} />,
      badge: activeLimitCount + newFailCount > 0 ? activeLimitCount + newFailCount : null,
      badgeTone: activeLimitCount > 0 ? 'fail' : 'warn',
    },
    {
      id: 'models',
      label: t('可用模型', 'Available models'),
      icon: <Cpu className="h-[15px] w-[15px]" strokeWidth={1.8} />,
      badge: modelCount != null ? modelCount : null,
      badgeTone: 'neutral',
    },
    {
      id: 'playground',
      label: t('对话测试与诊断', 'Chat test & diagnostics'),
      icon: <MessageSquare className="h-[15px] w-[15px]" strokeWidth={1.8} />,
      badge: diagFailCount > 0 ? diagFailCount : null,
      badgeTone: 'fail',
    },
    {
      id: 'clients',
      label: t('客户端接入', 'Client setup'),
      icon: <Link2 className="h-[15px] w-[15px]" strokeWidth={1.8} />,
    },
  ];

  const activeNav = navItems.find((n) => n.id === activeTab) || navItems[0];
  const currentAccentObj = ACCENT_PRESETS.find((p) => p.id === accent) || ACCENT_PRESETS[0];

  const renderSidebarNav = (mobile = false) => (
    <div className="flex h-full flex-col">
      {/* Sidebar Title */}
      <div className="flex items-center justify-between px-4 pt-5 pb-4">
        <div className="min-w-0">
          <div className="text-[15.5px] font-semibold tracking-[-0.025em] leading-tight truncate" style={{ color: 'var(--text)' }}>
            WorkBuddy
          </div>
          <div
            className="mono mt-1 text-[10px] font-medium uppercase tracking-[0.07em] truncate"
            style={{ color: 'var(--faint)' }}
          >
            {overview?.console?.version ? `LOCAL BRIDGE · v${overview.console.version}` : 'LOCAL BRIDGE'}
          </div>
        </div>
        {mobile && (
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            aria-label={t('关闭菜单', 'Close menu')}
            className="wb-btn wb-btn-ghost wb-btn-icon"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Quick Command Trigger */}
      <div className="px-3 pb-3.5">
        <button
          type="button"
          onClick={() => {
            if (mobile) setMobileNavOpen(false);
            onOpenPalette();
          }}
          className="group flex w-full items-center justify-between rounded-[10px] px-2.5 h-[33px] text-[12px] transition-all cursor-pointer"
          style={{
            background: 'var(--surface-tint)',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
          }}
        >
          <span className="flex items-center gap-2 truncate">
            <Search className="h-3.5 w-3.5 shrink-0 opacity-75 group-hover:opacity-100 transition-opacity" />
            <span className="truncate">{t('搜索命令或面板…', 'Jump to command…')}</span>
          </span>
          <kbd
            className="mono shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--faint)',
            }}
          >
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Navigation Tabs */}
      <div className="px-3 pt-1 flex-1 overflow-y-auto">
        <div
          className="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: 'var(--faint)' }}
        >
          {t('工作区', 'Workspace')}
        </div>
        <nav id={mobile ? undefined : 'navTabs'} className="nav-tabs space-y-0.5" aria-label={t('主导航', 'Main navigation')}>
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <div key={item.id} className="relative flex items-center">
                <button
                  type="button"
                  data-tab={item.id}
                  aria-pressed={active}
                  onClick={() => {
                    setActiveTab(item.id);
                    if (mobile) setMobileNavOpen(false);
                  }}
                  className={`nav-tab group flex w-full items-center gap-2.5 rounded-[8px] pl-2.5 ${item.badge != null ? 'pr-9' : 'pr-2.5'} h-[34px] text-[13px] transition-colors cursor-pointer ${active ? 'active font-semibold' : 'font-medium'}`}
                  style={{
                    background: active ? 'var(--surface-hover)' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--text-secondary)',
                  }}
                >
                  <span
                    className="shrink-0 transition-colors"
                    style={{ color: active ? 'var(--primary)' : 'var(--muted)' }}
                  >
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </button>
                {/* Badge kept outside .nav-tab button text so automated i18n/a11y label checks remain pure */}
                {item.badge != null && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-2 inline-flex min-w-[20px] h-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold"
                    style={
                      item.badgeTone === 'fail'
                        ? { background: 'var(--fail-soft)', color: 'var(--fail)' }
                        : item.badgeTone === 'warn'
                          ? { background: 'var(--warn-soft)', color: 'var(--warn)' }
                          : { background: 'var(--surface-subtle)', color: 'var(--muted)' }
                    }
                  >
                    {item.badge}
                  </span>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Sidebar Bottom Live Bridge Dock */}
      <div className="p-3 mt-auto">
        <div
          className="wb-inset p-3 space-y-2.5"
          style={{
            background: 'var(--surface)',
            borderColor: 'var(--border)',
            boxShadow: 'var(--shadow-xs), var(--specular)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-[12px] font-semibold" style={{ color: 'var(--text)' }}>
              <span
                className={`h-2 w-2 rounded-full ${badgeState === 'ok' ? 'wb-dot-pulse' : ''}`}
                style={{ background: badgeStyle.dot }}
              />
              {badgeLabel}
            </span>
            {b?.pid && (
              <span className="mono text-[10.5px]" style={{ color: 'var(--faint)' }}>
                #{b.pid}
              </span>
            )}
          </div>
          <div className="mono text-[11px] truncate" style={{ color: 'var(--muted)' }}>
            {b?.running
              ? `${fmtUptime(b.uptimeMs, en)} · :${b.port}`
              : b?.endpoint?.replace(/^https?:\/\//, '') || '127.0.0.1:8790'}
          </div>
          <div className="flex items-center gap-1.5">
            {!b?.ok ? (
              <button
                type="button"
                disabled={bridgeBusy}
                onClick={onStartBridge}
                className="wb-btn wb-btn-primary wb-btn-sm flex-1"
              >
                <Play className="h-3 w-3" />
                {t('启动', 'Start')}
              </button>
            ) : (
              <button
                type="button"
                disabled={bridgeBusy}
                onClick={onRestartBridge}
                className="wb-btn wb-btn-sm flex-1"
              >
                <RotateCw className="h-3 w-3" />
                {t('重启', 'Restart')}
              </button>
            )}
            <button
              type="button"
              disabled={bridgeBusy || !b?.running}
              onClick={onStopBridge}
              aria-label={t('停止桥服务', 'Stop bridge')}
              title={t('停止桥服务', 'Stop bridge')}
              className="wb-btn wb-btn-danger wb-btn-sm px-2.5"
            >
              <Square className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex">
      {/* Screen-reader polite announcer */}
      <div id="liveRegion" className="sr-only" role="status" aria-live="polite">
        {liveAnnouncement}
      </div>

      {/* Desktop Left Sidebar */}
      <aside
        className="hidden lg:flex lg:flex-col lg:w-[238px] lg:shrink-0 sticky top-0 h-screen"
        style={{
          background: 'var(--sidebar)',
          borderRight: '1px solid var(--border)',
          zIndex: 'var(--z-sidebar)',
        }}
      >
        {renderSidebarNav(false)}
      </aside>

      {/* Mobile Drawer Sidebar with Slide Enter + Exit */}
      {mobileNavRendered && (
        <div
          className={`fixed inset-0 lg:hidden flex ${mobileNavClosing ? 'wb-backdrop-out pointer-events-none' : 'wb-backdrop-in'}`}
          style={{
            zIndex: 'var(--z-modal)',
            background: 'rgba(0, 0, 0, 0.44)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMobileNavOpen(false);
          }}
        >
          <div
            className={`w-[262px] max-w-[85vw] h-full ${mobileNavClosing ? 'wb-drawer-out' : 'wb-drawer-in'}`}
            style={{ background: 'var(--sidebar)', borderRight: '1px solid var(--border)' }}
          >
            {renderSidebarNav(true)}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Frosted-Glass Sticky Header */}
        <header
          id="topBarSticky"
          className="wb-glass sticky top-0 px-4 sm:px-6 lg:px-8 h-[54px] flex items-center justify-between gap-3"
          style={{ zIndex: 'var(--z-sticky)' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label={t('打开导航菜单', 'Open navigation')}
              className="lg:hidden wb-btn wb-btn-ghost wb-btn-icon"
            >
              <Menu className="h-4.5 w-4.5" />
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-[14.5px] sm:text-[15px] font-semibold tracking-[-0.015em] truncate" style={{ color: 'var(--text)' }}>
                {activeNav.label}
              </h1>
              {overviewStamp && (
                <>
                  <span aria-hidden="true" className="hidden md:inline text-[11px]" style={{ color: 'var(--faint)' }}>·</span>
                  <span
                    id="overviewStamp"
                    className="hidden md:inline text-[11px] font-medium"
                    style={{ color: 'var(--faint)' }}
                  >
                    {t(`更新于 ${overviewStamp}`, `Updated ${overviewStamp}`)}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Live Bridge Status Pill */}
            <span
              id="badge"
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 h-[28px] text-[11.5px] font-semibold"
              style={{
                background: badgeStyle.bg,
                color: badgeStyle.fg,
                border: `1px solid ${badgeStyle.border}`,
              }}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${badgeState === 'ok' ? 'wb-dot-pulse' : ''}`}
                style={{ background: badgeStyle.dot }}
              />
              <span id="badgeText" className="hidden sm:inline">{badgeLabel}</span>
            </span>

            <span className="hidden sm:inline-block h-4 w-px mx-0.5" style={{ background: 'var(--border)' }} />

            {/* Language Switcher */}
            <button
              type="button"
              id="langToggle"
              onClick={toggleLang}
              title={t('切换语言 / Switch language', 'Switch language / 切换语言')}
              aria-label={en ? 'Switch to 中文' : 'Switch to English'}
              data-i18n-skip=""
              className="wb-btn wb-btn-ghost wb-btn-sm min-w-[34px] font-semibold"
            >
              <span id="langToggleText">{en ? '中' : 'EN'}</span>
            </button>

            {/* Theme Switcher */}
            <button
              type="button"
              id="themeToggle"
              onClick={toggleTheme}
              title={t('切换深色/浅色主题', 'Toggle dark / light theme')}
              aria-label={t('切换深色/浅色主题', 'Toggle dark / light theme')}
              className="wb-btn wb-btn-ghost wb-btn-icon"
            >
              {theme === 'dark' ? <Sun className="h-[15px] w-[15px]" /> : <Moon className="h-[15px] w-[15px]" />}
            </button>

            {/* Accent Color Picker */}
            <div ref={accentWrapRef} className="relative">
              <button
                type="button"
                id="accentToggle"
                onClick={() => setAccentOpen((v) => !v)}
                title={t('配色方案', 'Accent colour')}
                aria-label={t('配色方案', 'Accent colour')}
                aria-haspopup="menu"
                aria-expanded={accentOpen}
                className="wb-btn wb-btn-ghost wb-btn-icon"
              >
                <span
                  id="accentDot"
                  className="h-3.5 w-3.5 rounded-full ring-2 ring-offset-1"
                  style={{
                    background: currentAccentObj.swatch,
                    '--tw-ring-color': 'var(--border-strong)',
                    '--tw-ring-offset-color': 'var(--bg)',
                  } as React.CSSProperties}
                />
              </button>
              {accentRendered && (
                <div
                  id="accentMenu"
                  role="menu"
                  className={`wb-popover absolute right-0 mt-2 w-48 rounded-xl p-1.5 ${accentClosing ? 'wb-pop-out pointer-events-none' : 'wb-pop-in'}`}
                  style={{ zIndex: 'var(--z-dropdown)' }}
                >
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                    <Palette className="h-3 w-3" />
                    {t('强调色主题', 'Accent Theme')}
                  </div>
                  {ACCENT_PRESETS.map((preset) => {
                    const selected = accent === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => {
                          setAccent(preset.id);
                          setAccentOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors cursor-pointer"
                        style={{
                          background: selected ? 'var(--primary-soft)' : 'transparent',
                          color: selected ? 'var(--primary-text)' : 'var(--text)',
                        }}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: preset.swatch }} />
                          <span className="truncate">{en ? preset.en : preset.zh}</span>
                        </span>
                        {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Refresh All */}
            <button
              type="button"
              id="refreshBtn"
              disabled={refreshingAll}
              onClick={() => void refreshAll()}
              className="wb-btn wb-btn-sm ml-0.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{refreshingAll ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}</span>
            </button>
          </div>
        </header>

        {/* Mobile Quick Horizontal Tab Bar */}
        <div
          className="nav-tabs no-scrollbar lg:hidden overflow-x-auto px-4 py-2 flex items-center gap-1.5"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--sidebar)' }}
        >
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-tab={item.id}
                onClick={() => setActiveTab(item.id)}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium cursor-pointer"
                style={{
                  background: active ? 'var(--surface-hover)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-secondary)',
                  boxShadow: active ? 'inset 0 0 0 1px var(--border)' : 'none',
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Workspace Container */}
        <main className="flex-1 w-full max-w-[1380px] mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 space-y-5 pb-24">
          {children}
        </main>
      </div>

      {/* Floating Frosted-Glass Back to Top with Enter + Exit Animation */}
      {backTopRendered && (
        <button
          type="button"
          id="backToTop"
          onClick={() => window.scrollTo({ top: 0 })}
          title={t('返回页面顶部', 'Back to top')}
          aria-label={t('返回页面顶部', 'Back to top')}
          className={`wb-popover fixed right-5 bottom-5 inline-flex items-center gap-1.5 rounded-full px-3.5 h-9 text-[12px] font-semibold cursor-pointer ${
            showBackTop ? 'wb-toast-in' : 'wb-toast-out pointer-events-none'
          }`}
          style={{ zIndex: 'var(--z-sticky)', color: 'var(--text)' }}
        >
          <ArrowUp className="h-3.5 w-3.5" />
          <span>{t('回顶部', 'Top')}</span>
        </button>
      )}
    </div>
  );
};
