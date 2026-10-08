/**
 * ESLint 平面配置 —— 目标是「挡住真 bug」，不是统一风格：
 *   - 开：recommended 里能抓低级错误的核心规则；
 *   - 关：与本项目既有模式冲突、或纯风格类（每条都注明理由）；
 *   - 范围：仓库自有源码。vendor 快照、临时研究/优化目录不在门禁内；
 *     `tools/dev/` **在门禁内**（见下），测试目录放宽 no-unused-vars（夹具常量常见）。
 *
 * 门禁：`npm run lint`；类型检查是另一条腿（`npm run check:types`）。
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dsh-plugin/vendor/**',
      'node_modules/**',
      '.tmp-*/**',
      '.tmp-*',
      '.optimize/**',
      '.backup/**',
      '.workbuddy/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // ── 有理由地关闭（每条注明为什么）────────────────────────────────
      // 项目的「静默降级」惯用法：catch 留空 + 注释解释为什么可以忽略
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 服务器的有意长驻循环（while (true) 轮询 / 保持驻留）
      'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
      // `if ((line = read()))` 是既有代码的有意模式，且都包在括号里
      'no-cond-assign': 'off',
      // `.hasOwnProperty()` 直调在受控对象上使用，风险可控；不做批量改名
      'no-prototype-builtins': 'off',
      // YAML 转义（\x00-\x1f 控制字符）与对齐正则里的连续空格都是有意用途
      'no-control-regex': 'off',
      'no-regex-spaces': 'off',
      // eslint 10 新规则，历史代码里的少量命中价值低，留待顺手清理
      'no-useless-assignment': 'off',
      // 测试夹具里的常量/辅助变量常见且无害；生产代码仍保持 error
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: [
      'dsh-plugin/tests/**',
      'bridge/*.test.mjs',
      'lib/*.test.mjs',
      'tools/**',
    ],
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
