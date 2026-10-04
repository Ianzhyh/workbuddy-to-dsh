# WorkBuddy 控制台精致工程设计规范 (Blue Precision Design System)

> **版本**：v1.0.0  
> **适用范围**：WorkBuddy Local Bridge Web 控制台 (`dashboard/public/`)  
> **核心原则**：纯色克制 (Zero-Gradient Solid Aesthetic)、皇家蓝主调 (Solid Royal Blue)、严格层级圆角 (Unified Radius Hierarchy)、舒适呼吸节律 (4px/8px Spacing Grid)、优雅微动效 (Physical Micro-Interactions)。

---

## 1. 设计哲学与核心理念

本设计规范摒弃了泛滥、浮夸的多彩渐变与霓虹光晕，回归高质量专业工程工具（如 Linear、Vercel、GitHub Enterprise）的沉稳、严谨与高信息密度美学：

1. **纯正皇家蓝作为唯一主基调**：以经典纯粹的皇家蓝 (`#2563eb` / `#3b82f6`) 贯穿全局，构建强烈的专业工具品牌辨识度与操作视觉重心。
2. **纯实色与纸质感平整底色 (Anti-Gradient)**：严格杜绝一切背景与文字的杂乱渐变，通过极细 1px 发丝边框与纯平底色营造精致质感。
3. **统一且严谨的圆角层级 (Unified Radius)**：每个元素无论大小，必须严格对齐五级圆角规范（4px / 8px / 12px / 16px / 9999px），杜绝任何散落的随意数值。
4. **克制优雅的物理微交互 (Tactile Motion)**：动效仅用于明确状态变更、空间展开与交互反馈，使用统一的物理惯性缓动曲线 (`cubic-bezier(0.16, 1, 0.3, 1)`)，杜绝拖沓。

---

## 2. 色彩系统 (Color Tokens)

设计系统提供两套经过严格无障碍对比度（WCAG AA）校准的主题色板，浅色与深色主题由 `[data-theme="dark"]` 属性驱动。

### 2.1 主题色彩 (Brand Royal Blue)

| 令牌名 (Token) | 浅色模式 (Light) | 深色模式 (Dark) | 语义与应用场景 |
| :--- | :--- | :--- | :--- |
| `--primary` | `#2563eb` | `#3b82f6` | 核心品牌主色、主操作按钮、激活 Tab 背景、复选框、进度条填充 |
| `--primary-hover` | `#1d4ed8` | `#60a5fa` | 主按钮悬停态、强调操作悬停态 |
| `--primary-active` | `#1e40af` | `#2563eb` | 主按钮按下态、交互激活底色 |
| `--primary-subtle` | `#eff6ff` | `rgba(59, 130, 246, 0.12)` | 激活行背景、筛选胶囊底色、高亮提示微底色 |
| `--primary-border` | `#bfdbfe` | `rgba(59, 130, 246, 0.30)` | 激活状态发丝边框、抽屉栏展开强调边框 |
| `--primary-text` | `#1d4ed8` | `#60a5fa` | 蓝色区域正文字色、可点击模型 ID 高亮色 |
| `--accent` | `var(--primary)` | `var(--primary)` | 图表系列主色别名，确保 SVG 渲染纯正蓝 |

### 2.2 表面与中性色阶 (Surfaces & Neutrals)

| 令牌名 (Token) | 浅色模式 (Light) | 深色模式 (Dark) | 用途说明 |
| :--- | :--- | :--- | :--- |
| `--bg` | `#f8fafc` | `#090c13` | 页面最底层背景底色 |
| `--panel` | `#ffffff` | `#111622` | 主面板容器、操作栏、独立卡片前景色 |
| `--panel-hover` | `#fafbfc` | `#161c2b` | 表格行悬停、次要按钮悬停态 |
| `--panel-muted` | `#f1f5f9` | `#171e2e` | 表头背景、未激活选项底色 |
| `--panel-subtle` | `#f8fafc` | `#0f141f` | 工具栏底色、嵌套抽屉底色、输入框底色 |

### 2.3 边框体系 (Borders & Hairlines)

所有边框均采用纯色 1px 极细发丝线（Hairline Border）：
- `--border` (`#e2e8f0` / `rgba(255, 255, 255, 0.08)`): 标准分隔线、卡片边框。
- `--border-subtle` (`#edf2f7` / `rgba(255, 255, 255, 0.04)`): 表格行底线、次级分隔。
- `--border-strong` (`#cbd5e1` / `rgba(255, 255, 255, 0.18)`): 按钮默认边线、输入框外框。
- `--border-focus` (`#2563eb` / `#3b82f6`): 表单获取焦点时的高亮外框。

### 2.4 语义色彩体系 (Semantics)

| 状态 | 前景色 | 柔和浅底 (Soft) | 边框 (Border) | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **OK / 成功** | `#059669` / `#10b981` | `#ecfdf5` / `rgba(16, 185, 129, 0.12)` | `#a7f3d0` / `rgba(16, 185, 129, 0.28)` | 桥运行中、体检通过、签到成功 |
| **Warn / 警告** | `#d97706` / `#f59e0b` | `#fffbeb` / `rgba(245, 158, 11, 0.12)` | `#fde68a` / `rgba(245, 158, 11, 0.28)` | 凭据即将到期、非致命异常 |
| **Fail / 危险** | `#dc2626` / `#ef4444` | `#fef2f2` / `rgba(239, 68, 68, 0.12)` | `#fecaca` / `rgba(239, 68, 68, 0.28)` | 桥未运行、停止操作、请求报错 |
| **Promo / 促销** | `#be185d` / `#f43f5e` | `#fdf2f8` / `rgba(244, 63, 94, 0.12)` | `#fbcfe8` / `rgba(244, 63, 94, 0.28)` | 免费模型、限时促销标识 |

---

## 3. 统一圆角规范 (Radius Hierarchy)

整站严格遵循五级圆角阶梯，杜绝任何中间散落数值：

| 规范级别 | 变量名 | 数值 | 覆盖元素清单 |
| :--- | :--- | :--- | :--- |
| **Micro (微小)** | `--radius-xs` | `4px` | 迷你标签 (`.tag`)、版本角标 (`.brand-badge`)、代码片段 (`code`)、滚动条滑块 (`::-webkit-scrollbar-thumb`)、迷你按钮 (`button.mini`)、详情图标按钮 (`.infobtn`) |
| **Small (小)** | `--radius-sm` | `8px` | 标准按钮 (`button`)、输入框 (`input[type="text"]`)、下拉框 (`select`)、导航选项 (`.nav-tab`)、诊断行 (`.diag-row`)、提示框 (`.notice`)、终端代码块 (`pre.log`) |
| **Standard (标准)** | `--radius` | `12px` | **抽屉栏主外框 (`details`)**、**表格行详情展开抽屉 (`.detail-body`)**、HUD 状态卡片 (`.card`)、表格包裹外框 (`.tablewrap`)、操作工具条 (`.actions`)、模型工具栏 (`.regbar`)、对话输出容器 (`#chatOut`)、账号条目 (`.acct`)、告警栏 (`.alert`) |
| **Large (主面板)** | `--radius-lg` | `16px` | 模块主容器 (`.panel`)、全局大面板包裹外框 |
| **Full (完全胶囊)** | `--radius-full` | `9999px` | 运行状态胶囊 (`.badge`)、快速提问胶囊 (`.quick-pill`)、筛选标签芯片 (`.filterchip`)、进度条槽位与填充条 (`.ptrack`, `.pfill`, `.rank-track`, `.rank-fill`) |

---

## 4. 间距网格系统 (Spacing Rhythm)

基于统一的 4px / 8px 基础网格系统，提供高信息密度与呼吸感兼备的布局：

```css
--space-1: 4px;   /* 紧凑间隙：图标与文字微距、标签内间隙 */
--space-2: 8px;   /* 行内间距：按钮组间隔、输入框间隙、表单网格小边距 */
--space-3: 12px;  /* 模块内小间隙：工具条内边距、卡片标题与图标间距 */
--space-4: 16px;  /* 标准组件间隙：卡片网格 gap、表格内外边距 */
--space-5: 20px;  /* 结构模块外边距：面板间下边距、主操作条外边距 */
--space-6: 24px;  /* 主面板内边距：panel 内衬填充、大区块间隔 */
--space-8: 32px;  /* 全局段落分界：主要内容区分隔 */
```

### 关键组件间距规范

- **全局页面包裹器 (`.wrap`)**：最大宽度 `1180px`，页面边距 `28px 24px 80px`。
- **面板卡片 (`.panel`)**：内边距 `20px 24px`，模块间下外边距 `20px`。
- **状态卡片 (`.card`)**：内边距 `16px 18px`，网格间距 `16px`。
- **表格单元格 (`th`, `td`)**：水平边距 `14px`，垂直内边距 `10px`。
- **抽屉外框 (`details`)**：头部内边距 `13px 18px`，内容区内边距 `14px 18px 18px`。

---

## 5. 动效与交互规范 (Motion & Micro-interactions)

动效服务于界面的连贯感与操作反馈，杜绝拖泥带水。

### 5.1 物理缓动曲线与时间尺度

- **缓动曲线**：`--ease: cubic-bezier(0.16, 1, 0.3, 1)`（自然物理弹性回弹阻尼）。
- **极速响应 (Fast)**：`0.16s`，适用于按钮 hover、背景色渐变、文本高亮。
- **常规过度 (Normal)**：`0.22s ~ 0.24s`，适用于抽屉展开折叠、视图 Tab 切换、面板显隐。

### 5.2 微交互关键场景实现

1. **按钮反馈**：
   - 悬停：`transform: translateY(-1.5px)`，投影加深。
   - 按下：`transform: translateY(0.5px) scale(0.99)`，提供明确受压触感。
2. **抽屉栏展开 (Drawer Expand)**：
   - 箭头旋转：`<summary svg>` 保持 `transition: transform 0.24s var(--ease)`，展开旋转 `90deg`。
   - 隐藏浏览器原生黑三角：`summary::-webkit-details-marker { display: none !important; }`。
   - 抽屉内容淡入平移：`animation: drawerContentFade 0.22s var(--ease)`。
3. **表格展开详情抽屉 (`tr.detail-row`)**：
   - 内嵌卡片容器：`.detail-body` 采用 `border-radius: var(--radius)` 独立卡片化设计，伴随 `animation: detailExpand 0.22s var(--ease)` 平滑下移展开。
4. **运行状态呼吸光晕**：
   - 运行中绿色小圆点带有微弱脉冲光晕 (`@keyframes elegant-pulse`)，频率 2.2 秒。
5. **视图 Tab 切换**：
   - 激活项高亮突变，伴随面板内容微小向上淡入 (`@keyframes sectionFadeIn`)。

---

## 6. 组件设计规范详述

### 6.1 顶部品牌栏 (Header)
- 品牌图标：40x40 纯色皇家蓝底色，统一 12px 圆角，带有柔和蓝色立体投影。
- 状态胶囊：右上角展示健康度状态（`badge.ok` / `badge.fail`），统一胶囊圆角。
- 主题切换器与刷新按钮：统一 32px 紧凑高度，悬停平移微动效。

### 6.2 视图导航 Tab 切换器 (Nav Tabs)
- 外层容器：浅色边框与 12px 圆角包裹，内衬 4px。
- 选项卡：未激活时静止灰度，激活项 (`.nav-tab.active`) 采用纯正皇家蓝填充 (`--primary`)，白字白图标，搭配微投影，层级最高。

### 6.3 快捷操作栏 (Actions Bar)
- 工具条由「进程控制组」、「诊断复制组」与「实时状态消息」三段组成。
- 主操作按钮（启动桥/保存配置）使用 Solid Royal Blue，危险操作使用柔红底红字（悬停翻转为红底白字）。

### 6.4 HUD 核心指标卡 (Cards)
- 4 列自适应网格，右上角配对专用纯色 SVG 矢量图标（主色 Royal Blue）。
- 悬停时边框切换为主色蓝，卡片微微向上浮动 2px，右侧图标放大 1.1 倍。

### 6.5 数据表格与模型列表 (Table & Model Table)
- 外包裹器严格统一切圆角（12px），表头 sticky 固定，背景与边框色彩分明。
- 行选中态（勾选 checkbox 或点击联动）：整行附加 `rgba(37, 99, 235, 0.035)` 微弱蓝色底色，与未选中行区分清晰。
- 详情展开行：独立嵌套为 12px 圆角的浮层卡片，消除以往表格下沉断裂感。

### 6.6 抽屉栏组件 (Drawer Bar)
- `details`/`summary` 统一设计为带 12px 圆角的抽屉条。
- 默认收起态为紧凑的一体化灰色横条，悬停蓝色高亮；
- 展开态下边框高亮为蓝色细线，内部集成操作栏与独立终端暗色输出容器。

---

## 7. 规范落地检查清单 (Checklist)

开发或修改任何前端功能时，必须逐项核对：
- [x] **色彩检查**：主强调色是否严格为 `--primary`（皇家蓝）？是否存在任何随意硬编码的渐变？
- [x] **圆角检查**：圆角是否严格使用 `--radius-xs`, `--radius-sm`, `--radius`, `--radius-lg`, `--radius-full` 之一？
- [x] **抽屉检查**：所有展开折叠栏（包括日志抽屉、表格详情抽屉）是否拥有统一的 12px 圆角与柔和动效？
- [x] **间距检查**：组件 paddings 与 margins 是否为 4/8/12/16/20/24px 网格倍数？
- [x] **动效检查**：所有可点击控件是否配置了物理缓动过渡，避免突兀切换？
- [x] **深色模式检查**：暗色下所有文本与表面对比度是否清晰，无过曝或死黑？
