// Complete TypeScript contracts matching dashboard/server.mjs and tools/dev/api-shape.json

export type Lang = 'zh' | 'en';
export type Theme = 'light' | 'dark';
export type AccentId = 'blue' | 'terracotta' | 'moss' | 'violet' | 'teal';
export type NavTab = 'all' | 'overview' | 'models' | 'playground' | 'clients';

export interface BridgeAuth {
  source?: string;
  userId?: string;
  endpoint?: string;
  expiresAt?: string;
  expired?: boolean;
  changedAt?: string;
  enterpriseId?: string;
  tenantId?: string;
}

export interface AutoCheckinState {
  at?: number | string | null;
  result?: string;
  credit?: number;
}

export interface BridgeInfo {
  running: boolean;
  ok: boolean;
  host: string;
  port: number;
  endpoint: string;
  error: string | null;
  upstream: string;
  auth: BridgeAuth | null;
  credentialSource?: string;
  desktopUserId?: string;
  build?: string;
  expectedBuild?: string;
  staleBuild?: boolean;
  authFile?: string;
  selectedAuthFile?: string;
  pid: number | null;
  startedAt: string | null;
  uptimeMs: number | null;
  catalogSize: number | null;
  catalogAt: string | null;
  upstreamShape?: {
    droppedNonChat?: string[];
    officialPickerCount?: number;
    productModelCount?: number;
    [k: string]: unknown;
  } | null;
  autoCheckin?: AutoCheckinState | null;
  autoCheckinEnabled?: boolean;
}

export interface QuotaPackage {
  name: string;
  remain: number;
  size: number;
  monthly?: boolean;
  expiresAt?: string;
}

export interface QuotaInfo {
  ok?: boolean;
  total: number;
  unlimited?: boolean;
  packages?: QuotaPackage[];
  productCode?: string;
  account?: string;
  source?: string;
}

export interface CredentialActive {
  keyId?: string;
  envelopeKeyId?: string;
  keyIdMatches?: boolean;
  encrypted?: boolean;
  account?: string;
  userId?: string;
  alias?: string;
  domain?: string;
  tokenLen?: number;
  expiresAt?: number;
  remainingMs?: number;
}

export interface CredentialsInfo {
  files: Array<{
    name: string;
    isActiveTarget?: boolean;
    account?: string;
    domain?: string;
    encrypted?: boolean;
    expiresAt?: number;
    modifiedAt?: number;
  }>;
  active: CredentialActive | null;
  error: string | null;
  authFile?: string;
}

export interface DshInfo {
  settingsExists: boolean;
  settingsHasRoute: boolean;
  patchHasRoute: boolean;
  routeLive: boolean;
  routeSource: string | null;
  routeMode?: string;
  nativeRoute?: boolean;
  hasBridgeKey: boolean;
  bundlesOk: boolean;
  bundles: unknown[];
  registeredModels: string[];
}

export interface OverviewResponse {
  bridge: BridgeInfo;
  console: {
    version: string;
    build?: string;
    pid?: number;
    node: string;
  };
  credentials: CredentialsInfo;
  quota: QuotaInfo | null;
  dsh: DshInfo;
  error?: string;
}

export interface IdentityResponse {
  ok: boolean;
  pid?: number | null;
  build?: string;
  auth?: BridgeAuth | null;
  desktopUserId?: string;
  error?: string;
}

export interface ModelItem {
  id: string;
  name?: string;
  vendor?: string;
  owned_by?: string;
  context_window?: number;
  context_window_default?: number;
  context_window_max?: number;
  context_window_options?: number[];
  max_output_tokens?: number;
  credits?: number;
  free?: boolean;
  badge?: string;
  promotion_active?: boolean;
  promotion_text?: string;
  promotion_until?: string;
  promotion_factor?: number;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  reasoning_efforts?: string[];
  default_reasoning_effort?: string;
  default_temperature?: number;
  only_reasoning?: boolean;
  official?: boolean;
  tags?: string[];
  description_zh?: string;
  description_en?: string;
  busy_level?: string | null;
  busy?: string | { level?: string; status?: string; label?: string } | null;
  busyLevel?: string;
}

export interface ModelsDefaultInfo {
  ok?: boolean;
  mode: 'curated' | 'all' | 'ids' | string;
  ids?: string[];
  source?: string;
  env?: string;
  saved?: { mode?: string; ids?: string[] } | null;
  file?: string;
  total?: number;
  count?: number;
  invalid?: string;
}

export interface ModelsResponse {
  models: ModelItem[];
  modelsDefault?: ModelsDefaultInfo | null;
  staleMs?: number | null;
  error?: string;
}

export interface ProbeRecord {
  ok: boolean;
  ms?: number;
  at?: number;
  credit?: number | null;
  error?: string | null;
  inputTokens?: number | null;
  promptTokens?: number | null;
}

export interface ProbeResultsResponse {
  updatedAt?: number | null;
  results?: Record<string, ProbeRecord>;
  lastRun?: { scope?: string; count?: number; at?: number } | null;
}

export interface TpsSample {
  model: string;
  tokensPerSecond?: number;
  timeToFirstTokenMs?: number;
  samples?: number;
  complete?: boolean;
  reason?: string;
}

export interface TpsResponse {
  ok: boolean;
  cached?: boolean;
  sample?: TpsSample;
  error?: string;
}

export interface AccountEntry {
  name: string;
  path?: string;
  active?: boolean;
  usable?: boolean;
  account?: string;
  domain?: string;
  encrypted?: boolean;
  expiresAt?: number;
  remainingMs?: number;
  modifiedAt?: number;
  userId?: string;
  aliasKey?: string;
  alias?: string;
  hidden?: boolean;
  sameAccount?: number;
  balance?: number | null;
  balanceError?: string;
  error?: string;
}

export interface AccountsResponse {
  dir?: string;
  active?: string;
  desktopAuth?: string;
  desktopUid?: string;
  accounts: AccountEntry[];
  error?: string;
  keyError?: string | null;
}

export interface PluginCredential {
  uid: string;
  nickname?: string;
  region?: 'cn' | 'global' | string;
  enterpriseId?: string;
  active?: boolean;
  expiresAt?: number | string;
  remainingMs?: number;
  expired?: boolean;
}

export interface PluginLoginResponse {
  ok: boolean;
  configured?: 'auto' | 'desktop' | 'plugin' | string;
  configuredSource?: string;
  envPinned?: boolean;
  effective?: { source?: string; uid?: string } | null;
  desktop?: { available?: boolean } | null;
  plugin?: { error?: string | null } | null;
  credentials: PluginCredential[];
  sameAccount?: boolean;
  failover?: string;
  storeMode?: 'dpapi' | 'memory' | string;
  fallbackReason?: string | null;
  loginRegion?: 'cn' | 'global' | string;
  error?: string;
}

export interface AccountArchiveEntry {
  key: string;
  uid?: string;
  uin?: string;
  account?: string;
  domain?: string;
  file?: string;
  savedAt?: number | string;
  expiresAt?: number;
  expired?: boolean;
}

export interface AccountArchiveResponse {
  ok: boolean;
  entries?: AccountArchiveEntry[];
  archived?: AccountArchiveEntry[];
  saved?: number;
  error?: string;
}

export interface AutoSwitchResponse {
  ok: boolean;
  after: number;
  envKey?: string;
  saved?: boolean;
  error?: string;
}

export interface LimitItem {
  kind: 'quota' | 'credits' | 'account_restricted' | 'rate_limit' | string;
  model: string;
  count?: number;
  lastAt?: string;
  resetAt?: string;
  resetAtSource?: string;
  uid?: string;
  accountLabel?: string;
  isCurrent?: boolean;
}

export interface LimitsResponse {
  ok: boolean;
  at?: string;
  account?: string;
  accountLabel?: string;
  expiredCount?: number;
  accountCount?: number;
  limiting: LimitItem[];
  error?: string;
}

export interface UsageModelRow {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  credit: number;
  creditCalls: number;
}

export interface UsageBucket {
  day?: string;
  hour?: string;
  label?: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  credit: number;
  creditCalls: number;
  searches?: number;
  searchFailed?: number;
  videos?: number;
  videoFailed?: number;
  byModel?: UsageModelRow[];
}

export interface UsageData {
  ok?: boolean;
  windowDays?: number;
  total: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    ms: number;
    credit: number;
    creditCalls: number;
    failed: number;
    cacheHitRate?: number | null;
    cacheKnownCalls?: number;
    cachedTokens?: number;
    searches?: number;
    searchFailed?: number;
    videos?: number;
    videoFailed?: number;
    videoCredit?: number;
    videoCreditKnown?: number;
    images?: number;
    imageFailed?: number;
    imageCredit?: number;
    imageCreditKnown?: number;
  };
  models: UsageModelRow[];
  days: UsageBucket[];
  hours?: UsageBucket[];
  failures?: unknown[];
  failureByModel?: unknown[];
}

export interface UsageResponse {
  usage: UsageData | null;
  error?: string;
}

export interface CheckinResponse {
  ok?: boolean;
  already?: boolean;
  credit?: number;
  message?: string;
  error?: string;
  status?: {
    active?: boolean;
    todayCheckedIn?: boolean;
    streakDays?: number;
    dailyCredit?: number;
    todayCredit?: number;
    isStreakDay?: boolean;
    nextStreakDay?: number;
    streakBonusDays?: number;
    streakBonusCredit?: number;
  } | null;
  checkin?: {
    auto?: boolean;
    lastAt?: number | null;
    lastResult?: string | null;
    lastError?: string | null;
    lastSource?: string | null;
  };
}

export interface CheckinAccountRow {
  userId?: string;
  nickname?: string;
  uin?: string;
  region?: string;
  domain?: string;
  authFile?: string;
  current?: boolean;
  expired?: boolean;
  expiresAt?: number;
  noActivity?: boolean;
  error?: string;
  status?: {
    active?: boolean;
    todayCheckedIn?: boolean;
    streakDays?: number;
    todayCredit?: number;
  };
}

export interface CheckinAccountsResponse {
  ok: boolean;
  claim?: boolean;
  totals?: {
    accounts: number;
    claimed: number;
    already: number;
    failed: number;
    skipped: number;
    credit: number;
  };
  accounts: CheckinAccountRow[];
  error?: string;
}

export interface RequestEntry {
  t: number;
  model: string;
  stream?: boolean;
  ok: boolean;
  ms: number;
  ttfbMs?: number;
  bridgeOverheadMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  uncachedTokens?: number;
  credit?: number | null;
  status?: number;
  code?: string | number | null;
  error?: string | null;
  failureClass?: string | null;
  probe?: boolean;
}

export interface ActiveRequestEntry {
  id?: string;
  model: string;
  stream?: boolean;
  startedAt?: number;
  runningMs?: number;
}

export interface RequestsResponse {
  requests: RequestEntry[];
  active?: ActiveRequestEntry[];
  activeAlertMs?: number;
  error?: string;
}

export interface DiagnoseItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

export interface DiagnoseResponse {
  items: DiagnoseItem[];
  summary?: { fail: number; warn: number; ok: number };
  error?: string;
}

export interface ClientsResponse {
  running: boolean;
  host: string;
  port: number;
  baseUrlOpenAI: string;
  baseUrlAnthropic: string;
  token: string;
  anthropicModel: string;
  anthropicFastModel: string;
  responsesModel: string;
  responsesFastModel: string;
  models: string[];
  modelDetails: Array<{
    id: string;
    name: string;
    context: number;
    contextMax?: number;
    maxOutput: number;
    supportsReasoning?: boolean;
    supportsImages?: boolean;
  }>;
  error?: string;
}

export interface ConnectChange {
  path: string;
  kind?: string;
  from: unknown;
  to: unknown;
}

export interface ConnectProfileInfo {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  applied: boolean;
  changed: boolean;
  canSwitchBack: boolean;
  error: string | null;
  catalogSkipped: string | null;
  launch: string;
  appSupported: boolean;
}

export interface ConnectClientPlan {
  id: string;
  label: string;
  e2e?: boolean;
  installed?: boolean;
  exists?: boolean;
  path: string;
  pathSource?: { source?: string; envName?: string } | null;
  changed?: boolean;
  applied?: boolean;
  appliedAt?: string | null;
  reformats?: boolean;
  mode?: 'bridge' | 'native' | string;
  recordedMode?: string | null;
  canSwitchBack?: boolean;
  effectiveModel?: string | null;
  effectiveModels?: string[];
  models?: string[];
  changes?: ConnectChange[];
  preview?: string;
  error?: string | null;
  catalog?: {
    path?: string;
    name?: string;
    added?: string[];
    kept?: number;
    from?: string;
  } | null;
  catalogSkipped?: string | null;
  profile?: ConnectProfileInfo | null;
}

export interface ConnectResponse {
  clients: ConnectClientPlan[];
  token: string;
  baseUrlOpenAI: string;
  baseUrlAnthropic: string;
  model: string;
  modelOptions: Array<{ id: string; name?: string }>;
  catalogStale?: boolean;
  catalogAt?: string | null;
  running: boolean;
  bridge?: { up?: boolean; authRejected?: boolean };
  backupDir?: string;
  error?: string;
}

export interface ConnectVerifyResult {
  ok: boolean;
  written?: { ok: boolean; issues?: string[]; detail?: string };
  auth?: { ok: boolean; status?: number; error?: string; detail?: string } | null;
  error?: string;
}

export interface LogResponse {
  lines: string[];
  total?: number;
  file?: string;
  error?: string;
}
