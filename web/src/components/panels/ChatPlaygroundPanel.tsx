import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  ChevronRight,
  MessageSquare,
  Search,
  Send,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  User,
} from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { api, fmtCredit, fmtNum } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { useNativeInputSync } from '../../lib/useDomSync';
import type { LogResponse } from '../../types/api';
import { AnimatedDetails } from '../ui/AnimatedDetails';
import { CopyButton } from '../ui/CopyButton';
import { useDialog } from '../ui/Dialog';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRound {
  id: number;
  userText: string;
  assistantText: string;
  reasoningChars: number;
  meta: string;
  error?: string;
  streaming?: boolean;
}

const EFFORT_LABELS: Record<string, { zh: string; en: string }> = {
  minimal: { zh: '最低', en: 'Minimal' },
  low: { zh: '低', en: 'Low' },
  medium: { zh: '中', en: 'Medium' },
  high: { zh: '高', en: 'High' },
  max: { zh: '最高', en: 'Max' },
  xhigh: { zh: '极高', en: 'XHigh' },
};

const QUICK_PROMPTS = [
  { zhLabel: '介绍你自己', enLabel: 'Introduce yourself', zhPrompt: '用一句话介绍你自己', enPrompt: 'Introduce yourself in one sentence.' },
  { zhLabel: '快速排序', enLabel: 'Quicksort', zhPrompt: '写一个 Python 快速排序算法并附带简短注释', enPrompt: 'Write a concise Python quicksort with brief comments.' },
  { zhLabel: 'Context Window', enLabel: 'Context Window', zhPrompt: '请简述大语言模型中 Context Window 与输出 Token 的关系', enPrompt: 'Briefly explain the relationship between Context Window and max output tokens in LLMs.' },
  { zhLabel: '程序员冷笑话', enLabel: 'Dev joke', zhPrompt: '讲一个关于程序员调 bug 的冷笑话', enPrompt: 'Tell a short joke about debugging.' },
];

export const ChatPlaygroundPanel: React.FC = () => {
  const { models, setMsg } = useConsole();
  const { en, t } = useI18n();
  const { confirm } = useDialog();

  const catalog = models?.models || [];
  const [modelSearch, setModelSearch] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');

  // Prompt state (auto-tracks default bilingual prompt until user types)
  const [promptTouched, setPromptTouched] = useState(false);
  const [prompt, setPrompt] = useState('用一句话介绍你自己');
  const displayPrompt = promptTouched ? prompt : t('用一句话介绍你自己', 'Introduce yourself in one sentence.');

  // Sampling params (empty = omit; strict validation; effort follows selected model & resets on switch)
  const [maxTokensStr, setMaxTokensStr] = useState('');
  const [temperatureStr, setTemperatureStr] = useState('');
  const [effort, setEffort] = useState('');

  const promptInputRef = useNativeInputSync<HTMLInputElement>((el) => {
    setPromptTouched(true);
    setPrompt(el.value);
  });
  const maxTokensRef = useNativeInputSync<HTMLInputElement>((el) => setMaxTokensStr(el.value));
  const temperatureRef = useNativeInputSync<HTMLInputElement>((el) => setTemperatureStr(el.value));

  // Multi-turn chat state
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: 'You are a concise assistant.' }]);
  const [rounds, setRounds] = useState<ChatRound[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [validationError, setValidationError] = useState('');
  const chatCtrlRef = useRef<AbortController | null>(null);
  const chatOutRef = useRef<HTMLDivElement | null>(null);
  const roundSeqRef = useRef(0);

  // Bridge Log Drawer state (polls every 3s ONLY when open!)
  const [logOpen, setLogOpen] = useState(false);
  const [logCurrentOnly, setLogCurrentOnly] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [logErrorsOnly, setLogErrorsOnly] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const logPreRef = useRef<HTMLPreElement | null>(null);

  // Filter models for selector
  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
  }, [catalog, modelSearch]);

  // Keep selectedModelId valid
  useEffect(() => {
    if (!filteredModels.length) return;
    if (!selectedModelId || !filteredModels.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(filteredModels[0].id);
    }
  }, [filteredModels, selectedModelId]);

  const selectedModel = useMemo(
    () => catalog.find((m) => m.id === selectedModelId) || null,
    [catalog, selectedModelId],
  );
  const effortLevels = useMemo(
    () => (Array.isArray(selectedModel?.reasoning_efforts) ? selectedModel.reasoning_efforts : []),
    [selectedModel],
  );

  // Reset reasoning effort whenever switching to a model that does not support the previous level
  const prevModelIdRef = useRef('');
  useEffect(() => {
    if (prevModelIdRef.current && prevModelIdRef.current !== selectedModelId) {
      setEffort('');
    }
    prevModelIdRef.current = selectedModelId;
  }, [selectedModelId]);

  // Strict parameter validator (`chatOverrides` marker preserved for parity)
  const chatOverrides = (): { ok: boolean; params: Record<string, unknown>; errors: string[] } => {
    const params: Record<string, unknown> = {};
    const errors: string[] = [];

    const mt = maxTokensStr.trim();
    if (mt !== '') {
      const n = Number(mt);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        errors.push(t('max_tokens 需要是正整数', 'max_tokens must be a positive integer'));
      } else {
        params.max_tokens = n;
      }
    }

    const tp = temperatureStr.trim();
    if (tp !== '') {
      const n = Number(tp);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        errors.push(t('temperature 需要是 0–2 之间的数字', 'temperature must be a number between 0 and 2'));
      } else {
        params.temperature = n;
      }
    }

    if (effort && effortLevels.includes(effort)) {
      params.reasoning_effort = effort;
    }

    return { ok: errors.length === 0, params, errors };
  };

  const scrollChatIfNearBottom = (force = false) => {
    const el = chatOutRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    if (force || nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  };

  const handleSend = async () => {
    if (streaming) return;
    const domPrompt = (document.getElementById('promptInput') as HTMLInputElement | null)?.value;
    const text = (domPrompt !== undefined ? domPrompt : displayPrompt).trim();
    if (!text) return;
    if (!selectedModelId) {
      setValidationError(t('请先选择一个可用模型。', 'Select an available model first.'));
      return;
    }

    const ov = chatOverrides();
    if (!ov.ok) {
      setValidationError(
        `${t('参数不合法：', 'Invalid parameters: ')}${ov.errors.join('；')}${t('。请改正或清空后再发送。', '. Fix or clear them before sending.')}`,
      );
      return;
    }
    setValidationError('');

    const roundId = ++roundSeqRef.current;
    historyRef.current.push({ role: 'user', content: text });
    const reqMessages = [...historyRef.current];

    setRounds((prev) => [
      ...prev,
      { id: roundId, userText: text, assistantText: '', reasoningChars: 0, meta: t('等待首字节…', 'Waiting for first token…'), streaming: true },
    ]);
    scrollChatIfNearBottom(true);

    const ctrl = new AbortController();
    chatCtrlRef.current = ctrl;
    setStreaming(true);
    const t0 = performance.now();

    let answer = '';
    let reasoningChars = 0;
    let lastUsage: { prompt_tokens?: number; completion_tokens?: number; credit?: number } | null = null;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-workbuddy-panel': '1' },
        body: JSON.stringify({
          model: selectedModelId,
          messages: reqMessages,
          stream: true,
          ...ov.params,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 220)}` : ''}`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number; credit?: number };
              };
              if (chunk.usage) lastUsage = chunk.usage;
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.reasoning_content) reasoningChars += delta.reasoning_content.length;
              if (delta?.content) {
                answer += delta.content;
                setRounds((prev) =>
                  prev.map((r) =>
                    r.id === roundId
                      ? { ...r, assistantText: answer, reasoningChars, meta: t('生成中…', 'Streaming…') }
                      : r,
                  ),
                );
                scrollChatIfNearBottom(false);
              }
            } catch {
              /* ignore partial/non-JSON SSE lines */
            }
          }
        }
      }

      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      if (!answer) {
        historyRef.current.pop();
        setRounds((prev) =>
          prev.map((r) =>
            r.id === roundId
              ? { ...r, streaming: false, meta: t(`（无内容返回）用时 ${elapsed}s`, `(No content returned) ${elapsed}s`) }
              : r,
          ),
        );
      } else {
        historyRef.current.push({ role: 'assistant', content: answer });
        const metaParts: string[] = [];
        if (lastUsage) {
          metaParts.push(
            t(
              `输入 ${fmtNum(lastUsage.prompt_tokens || 0)} / 输出 ${fmtNum(lastUsage.completion_tokens || 0)} tokens`,
              `In ${fmtNum(lastUsage.prompt_tokens || 0)} / Out ${fmtNum(lastUsage.completion_tokens || 0)} tok`,
            ),
          );
          const creditStr =
            typeof lastUsage.credit === 'number'
              ? fmtCredit(lastUsage.credit, true)
              : t('—（上游未回报）', '— (unreported)');
          metaParts.push(`${t('扣分', 'Credit')} ${creditStr}`);
        }
        metaParts.push(`${elapsed}s`);
        if (reasoningChars > 0) metaParts.push(t(`思考 ${reasoningChars} 字`, `Reasoning ${reasoningChars} chars`));

        setRounds((prev) =>
          prev.map((r) =>
            r.id === roundId
              ? { ...r, assistantText: answer, reasoningChars, streaming: false, meta: metaParts.join(' · ') }
              : r,
          ),
        );
      }
    } catch (err) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      if ((err as Error)?.name === 'AbortError') {
        if (answer) historyRef.current.push({ role: 'assistant', content: answer });
        else historyRef.current.pop();
        setRounds((prev) =>
          prev.map((r) =>
            r.id === roundId
              ? { ...r, assistantText: answer, reasoningChars, streaming: false, meta: t(`已手动停止 · 用时 ${elapsed}s`, `Stopped manually · ${elapsed}s`) }
              : r,
          ),
        );
      } else {
        historyRef.current.pop();
        const msg = String((err as Error)?.message || err);
        setRounds((prev) =>
          prev.map((r) =>
            r.id === roundId
              ? { ...r, streaming: false, error: msg, meta: `${t('失败', 'Failed')} · ${elapsed}s` }
              : r,
          ),
        );
      }
    } finally {
      chatCtrlRef.current = null;
      setStreaming(false);
    }
  };

  const handleClearChat = () => {
    chatCtrlRef.current?.abort();
    historyRef.current = [{ role: 'system', content: 'You are a concise assistant.' }];
    setRounds([]);
    setValidationError('');
  };

  // Context size warning check
  const totalHistoryChars = historyRef.current.reduce((s, m) => s + m.content.length, 0);
  const historyNearLimit = historyRef.current.length >= 20 || totalHistoryChars >= 12_000;

  // Bridge logs loader & 3s poller ONLY when drawer open
  const fetchLogs = async (currentOnly = logCurrentOnly) => {
    const url = currentOnly ? '/api/bridge/log?lines=80&current=1' : '/api/bridge/log?lines=80';
    const d = await api<LogResponse>(url);
    if (d && Array.isArray(d.lines)) {
      setLogLines(d.lines);
      setLogTotal(d.total ?? d.lines.length);
      requestAnimationFrame(() => {
        if (logPreRef.current) logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
      });
    }
  };

  useEffect(() => {
    if (!logOpen) return;
    void fetchLogs(logCurrentOnly);
    const id = window.setInterval(() => {
      if (!document.hidden) void fetchLogs(logCurrentOnly);
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logOpen, logCurrentOnly]);

  const filteredLogLines = useMemo(() => {
    const q = logFilter.trim().toLowerCase();
    return logLines.filter((line) => {
      if (logErrorsOnly && !/error|interrupted|failed/i.test(line)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logErrorsOnly, logFilter, logLines]);

  const handleClearLog = async () => {
    const ok = await confirm(
      t('确定清空 bridge.log？当前桥进程会继续往新文件里写。', 'Clear bridge.log? The running bridge will continue appending to the file.'),
      { danger: true },
    );
    if (!ok) return;
    const r = await api('/api/bridge/log', { method: 'DELETE' });
    if (r._httpOk) {
      setMsg(t('桥日志已清空。', 'Bridge log cleared.'), 'good');
      void fetchLogs(logCurrentOnly);
    }
  };

  const defaultEffortLabel = selectedModel?.default_reasoning_effort
    ? EFFORT_LABELS[selectedModel.default_reasoning_effort]
      ? en
        ? EFFORT_LABELS[selectedModel.default_reasoning_effort].en
        : EFFORT_LABELS[selectedModel.default_reasoning_effort].zh
      : selectedModel.default_reasoning_effort
    : '';

  const effortHint =
    effortLevels.length === 0
      ? t('这个模型没有思考档位（上游未提供）', 'This model has no reasoning levels (not provided upstream)')
      : defaultEffortLabel
        ? t(`留空 = 模型默认档位（${defaultEffortLabel}）`, `Empty = model default (${defaultEffortLabel})`)
        : t('留空 = 模型默认档位', 'Empty = the model default level');

  return (
    <Panel
      section="playground"
      title={t('对话测试', 'Chat playground')}
      subtitle={t('端到端多轮流式对话验证与实时桥日志终端', 'End-to-end multi-turn streaming chat test & live bridge log viewer')}
      icon={<MessageSquare className="h-4 w-4" />}
      actions={
        <div className="flex items-center gap-2 text-[12px]" style={{ color: historyNearLimit ? 'var(--warn)' : 'var(--faint)' }}>
          {rounds.length > 0 && (
            <span>
              {t(`本轮上下文 ${historyRef.current.length} 条 · 约 ${fmtNum(totalHistoryChars)} 字符`, `Context ${historyRef.current.length} msgs · ~${fmtNum(totalHistoryChars)} chars`)}
              {historyNearLimit ? t('（建议清空对话）', ' (consider clearing)') : ''}
            </span>
          )}
          <button
            type="button"
            id="chatClearBtn"
            onClick={handleClearChat}
            title={t('清空对话历史与输出（不影响模型选择与搜索词）', 'Clear chat history and output')}
            className="wb-btn wb-btn-sm"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('清空对话', 'Clear chat')}
          </button>
        </div>
      }
    >
      <div className="space-y-3.5">
        {/* Quick Prompt Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.zhLabel}
              type="button"
              onClick={() => {
                setPromptTouched(true);
                setPrompt(en ? qp.enPrompt : qp.zhPrompt);
              }}
              className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer"
              style={{
                background: 'var(--surface-subtle)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
              }}
            >
              {en ? qp.enLabel : qp.zhLabel}
            </button>
          ))}
        </div>

        {/* Model Picker + Prompt Input */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-[165px]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--faint)' }} />
            <input
              type="text"
              id="modelSearch"
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              placeholder={t('搜索模型…', 'Filter models…')}
              className="wb-input wb-input-sm w-full pl-8"
            />
          </div>

          <Select
            id="modelSel"
            title={t('选择测试模型', 'Select model')}
            value={selectedModelId}
            onChange={setSelectedModelId}
            options={
              filteredModels.length === 0
                ? [{ value: '', label: t('（无匹配模型）', '(no matching model)') }]
                : filteredModels.map((m) => ({ value: m.id, label: m.id, description: m.name !== m.id ? m.name : undefined }))
            }
            className="min-w-[190px] max-w-[260px]"
            menuMinWidth={240}
          />

          <input
            ref={promptInputRef}
            type="text"
            id="promptInput"
            value={displayPrompt}
            onChange={(e) => {
              setPromptTouched(true);
              setPrompt(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={t('输入测试消息，按 Enter 发送…', 'Type a prompt and press Enter…')}
            className="wb-input wb-input-sm flex-1 min-w-[220px]"
          />

          <button
            type="button"
            id="sendBtn"
            disabled={streaming}
            onClick={() => void handleSend()}
            className="wb-btn wb-btn-primary wb-btn-sm"
          >
            <Send className="h-3.5 w-3.5" />
            {t('发送', 'Send')}
          </button>

          {streaming && (
            <button
              type="button"
              id="chatStopBtn"
              onClick={() => chatCtrlRef.current?.abort()}
              className="wb-btn wb-btn-danger wb-btn-sm"
            >
              <Square className="h-3 w-3" />
              {t('停止', 'Stop')}
            </button>
          )}
        </div>

        {/* Sampling Parameters Strip */}
        <div
          data-fn="chatOverrides"
          className="wb-inset px-3.5 py-2.5 flex flex-wrap items-center gap-3 text-[12px]"
        >
          <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--muted)' }}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('采样参数', 'Params')}
          </span>

          <label className="inline-flex items-center gap-1.5" title={t('单次回复的最大 token 数；留空 = 上游默认', 'Max tokens per reply; empty = upstream default')}>
            <span className="mono" style={{ color: 'var(--text-secondary)' }}>max_tokens</span>
            <input
              ref={maxTokensRef}
              type="number"
              id="chatMaxTokens"
              min="1"
              step="1"
              value={maxTokensStr}
              onChange={(e) => setMaxTokensStr(e.target.value)}
              placeholder={t('默认', 'Default')}
              className="wb-input wb-input-sm w-[92px] mono"
            />
          </label>

          <label className="inline-flex items-center gap-1.5" title={t('采样温度 0–2；留空 = 上游默认', 'Sampling temperature 0–2; empty = upstream default')}>
            <span className="mono" style={{ color: 'var(--text-secondary)' }}>temperature</span>
            <input
              ref={temperatureRef}
              type="number"
              id="chatTemperature"
              min="0"
              max="2"
              step="0.1"
              value={temperatureStr}
              onChange={(e) => setTemperatureStr(e.target.value)}
              placeholder={t('默认', 'Default')}
              className="wb-input wb-input-sm w-[84px] mono"
            />
          </label>

          <span className="inline-flex items-center gap-1.5" title={t('回答前的思考深度；留空 = 模型默认档位', 'Reasoning depth before answering; empty = model default')}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('思考强度', 'Reasoning effort')}</span>
            <Select
              id="chatEffort"
              title={t('思考强度', 'Reasoning effort')}
              disabled={effortLevels.length === 0}
              value={effort}
              onChange={setEffort}
              options={[
                { value: '', label: t('默认', 'Default') },
                ...effortLevels.map((lvl) => ({
                  value: lvl,
                  label: EFFORT_LABELS[lvl] ? (en ? EFFORT_LABELS[lvl].en : EFFORT_LABELS[lvl].zh) : lvl,
                })),
              ]}
              menuMinWidth={128}
            />
          </span>

          <span id="chatParamsHint" className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
            {effortHint}
          </span>
        </div>

        {/* Chat Output Stream */}
        <div
          ref={chatOutRef}
          id="chatOut"
          className="rounded-xl p-4 min-h-[160px] max-h-[460px] overflow-y-auto space-y-3.5"
          style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}
        >
          {validationError && (
            <div className="rounded-xl px-3.5 py-2.5 text-[12.5px] font-medium" style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}>
              {validationError}
            </div>
          )}

          {rounds.length === 0 && !validationError ? (
            <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>
              {t('等待发送… 选择模型后输入问题即可测试完整链路。', 'Waiting to send… Pick a model and send a message to verify end-to-end streaming.')}
            </div>
          ) : (
            rounds.map((r) => (
              <div key={r.id} className="space-y-2.5">
                {/* User Turn */}
                <div className="flex justify-end">
                  <div
                    className="max-w-[85%] rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-[13px] leading-relaxed"
                    style={{ background: 'var(--primary-solid)', color: 'var(--on-solid)' }}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] opacity-70 mb-1">
                      <User className="h-3 w-3" />
                      <span>{t('你', 'You')}</span>
                    </div>
                    <div className="turn-body whitespace-pre-wrap break-words" data-i18n-skip="">
                      {r.userText}
                    </div>
                  </div>
                </div>

                {/* Assistant Turn */}
                <div className="flex justify-start">
                  <div
                    className="max-w-[92%] w-full sm:w-auto rounded-2xl rounded-tl-sm px-4 py-3 space-y-2"
                    style={{
                      background: 'var(--surface)',
                      border: `1px solid ${r.error ? 'var(--fail-border)' : 'var(--border)'}`,
                    }}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2 text-[11.5px] font-semibold" style={{ color: 'var(--primary-text)' }}>
                        <Bot className="h-3.5 w-3.5" />
                        <span className="mono">{selectedModelId}</span>
                        {r.reasoningChars > 0 && (
                          <span className="wb-tag wb-tag-promo">
                            <Brain className="h-3 w-3" />
                            {t(`思考 ${r.reasoningChars} 字`, `${r.reasoningChars} chars`)}
                          </span>
                        )}
                      </div>
                      {r.assistantText && !r.streaming && (
                        <CopyButton text={r.assistantText} label={t('回复', 'reply')} variant="ghost" size="sm" />
                      )}
                    </div>

                    {r.error ? (
                      <div className="text-[12.5px] mono break-all" style={{ color: 'var(--fail)' }} data-i18n-skip="">
                        {r.error}
                      </div>
                    ) : (
                      <div className="turn-body text-[13.5px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--text)' }} data-i18n-skip="">
                        {r.assistantText}
                        {r.streaming && (
                          <span className="inline-block w-2 h-4 ml-1 align-middle rounded-xs wb-dot-pulse" style={{ background: 'var(--primary)' }} />
                        )}
                      </div>
                    )}

                    <div className="text-[11.5px] mono" style={{ color: 'var(--faint)' }}>
                      {r.meta}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Smoothly Animated Bridge Log Terminal Drawer */}
        <AnimatedDetails
          id="logDrawer"
          open={logOpen}
          onOpenChange={setLogOpen}
          className="rounded-xl overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-subtle)' }}
          summaryClassName="px-4 py-2.5 flex items-center justify-between cursor-pointer select-none text-[13px] font-semibold"
          summaryStyle={{ color: 'var(--text)' }}
          summary={
            <>
              <span className="inline-flex items-center gap-2">
                <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${logOpen ? 'rotate-90' : ''}`} style={{ color: 'var(--muted)' }} />
                <Terminal className="h-4 w-4" style={{ color: 'var(--primary-text)' }} />
                <span>{t('查看桥日志（最近 80 行）', 'View bridge logs (last 80 lines)')}</span>
              </span>
              <span id="logInfo" className="text-[11.5px] font-normal mono" style={{ color: 'var(--faint)' }}>
                {logOpen ? t(`显示 ${filteredLogLines.length} / 总 ${logTotal} 行`, `Showing ${filteredLogLines.length} / ${logTotal}`) : t('展开后每 3 秒自动刷新', 'Auto-refreshes every 3s when open')}
              </span>
            </>
          }
        >
          <div className="px-4 pb-4 pt-2 space-y-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <div className="flex flex-wrap items-center gap-3">
              <Switch
                id="logCurrentOnly"
                checked={logCurrentOnly}
                onChange={setLogCurrentOnly}
                label={t('只看本次启动', 'Current boot only')}
              />

              <input
                type="text"
                id="logFilter"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder={t('按关键字过滤（大小写不敏感）…', 'Filter by keyword…')}
                className="wb-input wb-input-sm flex-1 min-w-[180px] max-w-[260px]"
              />

              <Switch
                id="logErrorsOnly"
                checked={logErrorsOnly}
                onChange={setLogErrorsOnly}
                label={t('只看错误', 'Errors only')}
              />

              <div className="flex-1" />

              <button
                type="button"
                id="logClearBtn"
                onClick={() => void handleClearLog()}
                className="wb-btn wb-btn-danger wb-btn-sm"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('清空日志', 'Clear log')}
              </button>
            </div>

            <pre
              ref={logPreRef}
              id="logOut"
              data-i18n-skip=""
              className="log rounded-xl p-3.5 max-h-[300px] overflow-auto text-[11.5px] leading-relaxed"
              style={{
                background: '#0a0b0f',
                color: '#d4d8e2',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {filteredLogLines.length ? filteredLogLines.join('\n') : t('（暂无日志输出）', '(No log output)')}
            </pre>
          </div>
        </AnimatedDetails>
      </div>
    </Panel>
  );
};
