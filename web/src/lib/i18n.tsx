import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Lang } from '../types/api';
import { lsGet, lsSet } from './api';

const I18N_LANG_KEY = 'wb-lang';

/** Upstream proper nouns & server-generated strings translated cleanly in English mode.
 *  Synced with shared `window.I18N_TERMS_EN` (aligned 1:1 with dsh-plugin/lib/client.js). */
const DEFAULT_TERMS: Record<string, string> = {
  'CodeBuddy个人版拉新权益包': 'CodeBuddy Personal Referral Pack',
  'CodeBuddy个人版国内运营裂变包': 'CodeBuddy Personal Domestic Viral Pack',
  'CodeBuddy个人体验版': 'CodeBuddy Personal Trial',
  '企业/教育月度额度': 'Enterprise/education monthly quota',
  '个人体验版': ' Personal Trial',
  '个人版': ' Personal',
  '限时免费': 'Limited-time free',
  '限时折扣': 'Limited-time discount',
  '夜间免费': 'Free at night',
  '夜间折扣': 'Night discount',
  '错峰使用': 'Off-peak use',
  '促销进行中': 'Promotion active',
  '促销未生效': 'Promotion scheduled',
  '促销说明': 'Promotion details',
  '促销截止': 'Promotion ends',
  '（进行中）': ' (active)',
  '（未生效）': ' (not active)',
};

const UPSTREAM_TERMS: Array<[string, string]> = Object.entries(
  (window as unknown as { I18N_TERMS_EN?: Record<string, string> }).I18N_TERMS_EN || DEFAULT_TERMS,
);

const UPSTREAM_EXACT: Record<string, string> = {
  '桥服务': 'Bridge service',
  'dsh 模型路由': 'DSH model route',
  '令牌文件权限': 'Token file permissions',
  '登录凭据': 'Login credentials',
  'AtRest 加密': 'AtRest encryption',
  '客户端安装布局': 'Client install layout',
  '本地端口': 'Local port',
  '尚未配置 workbuddy 路由': 'WorkBuddy route not configured yet',
  '在「可用模型」里勾选后保存': 'Select models in Available Models and save',
  '已就绪': 'Ready',
  '桥未运行': 'Bridge not running',
  '请求超时（20 秒），请重试': 'Request timed out (20s), please retry',
};

const UPSTREAM_RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/^(.+)\s+已响应$/, '$1 responded'],
  [/^(.+)（已收紧为仅本人可读）$/, '$1 (restricted to current user)'],
  [/^(.+)\s+未能收紧：(.+)$/, '$1 could not tighten permissions: $2'],
  [/^(\d+) 个，缺失 (\d+) 个（(\d+) 个随安装提供）\s*·\s*(.+)$/, '$1 total, $2 missing ($3 bundled) · $4'],
  [/^(\d+) 个，缺失 (\d+) 个，(\d+) 个无法确认\s*·\s*(.+)$/, '$1 total, $2 missing, $3 unverified · $4'],
  [/^(\d+) 个，缺失 (\d+) 个\s*·\s*(.+)$/, '$1 total, $2 missing · $3'],
  [/^无法确认：(.+?)。当前安装布局无法从磁盘确认.+$/, 'Unverified: $1. Current install layout cannot be verified on disk — if DSH starts normally you can ignore this.'],
  [/^安装链接已失效：(.+?)（.+?）。重装该 bundle 即可；.+$/, 'Broken install link: $1. Reinstall this bundle if needed; DSH can still start normally.'],
  [/^同机其它用户可能读到本地令牌.+手动修复：(.+)$/, 'Other local users may read the local token. Manual fix: $1'],
  [/^无法读取登录目录：(.+)$/, 'Cannot read login directory: $1'],
];

const EXTRA_UPSTREAM_REPLACEMENTS: Array<[string, string]> = [
  ['icacls 起不来：', 'icacls failed to start: '],
  ['<令牌文件>', '<token-file>'],
];

export function translateUpstream(text: string | null | undefined, lang: Lang): string {
  if (!text) return '';
  if (lang === 'zh') return text;
  const s = String(text).trim();
  if (UPSTREAM_EXACT[s]) return UPSTREAM_EXACT[s];
  let out = s;
  for (const [re, rep] of UPSTREAM_RULES) {
    if (re.test(out)) {
      out = typeof rep === 'function' ? out.replace(re, rep) : out.replace(re, rep);
      break;
    }
  }
  for (const [zh, en] of UPSTREAM_TERMS) {
    if (out.includes(zh)) out = out.split(zh).join(en);
  }
  for (const [zh, en] of EXTRA_UPSTREAM_REPLACEMENTS) {
    if (out.includes(zh)) out = out.split(zh).join(en);
  }
  return out;
}

interface I18nContextValue {
  lang: Lang;
  en: boolean;
  setLang: (next: Lang) => void;
  toggleLang: () => void;
  /** Inline bilingual picker: `t('中文', 'English')` — zero key drift, 100% type-safe */
  t: (zh: string, enText: string) => string;
  /** Translates backend/upstream Chinese strings in EN mode */
  tu: (text: string | null | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function withViewTransition(mutate: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduced && typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(mutate);
  } else {
    mutate();
  }
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(() => (lsGet(I18N_LANG_KEY) === 'en' ? 'en' : 'zh'));

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    lsSet(I18N_LANG_KEY, next);
    withViewTransition(() => {
      document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
      setLangState(next);
    });
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === 'en' ? 'zh' : 'en');
  }, [lang, setLang]);

  const en = lang === 'en';
  const t = useCallback((zh: string, enText: string) => (en ? enText : zh), [en]);
  const tu = useCallback((text: string | null | undefined) => translateUpstream(text, lang), [lang]);

  return (
    <I18nContext.Provider value={{ lang, en, setLang, toggleLang, t, tu }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
