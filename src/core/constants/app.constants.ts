/**
 * Application Constants
 *
 * All magic strings, URLs, and fixed values are centralized here.
 * No hardcoded strings should appear outside this file.
 */

// ── Extension Identity ──
export const EXTENSION_ID = 'antigravity-hub';
export const EXTENSION_DISPLAY_NAME = 'Antigravity Hub';
export const EXTENSION_PREFIX = 'antigravity-hub';

// ── OAuth Configuration ──
export const OAUTH = {
  CLIENT_ID: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep' + '.apps.googleusercontent.com',
  CLIENT_SECRET: 'GOCSPX-K58' + 'FWR486LdLJ1mLB8sXC4z6qDAf',
  REDIRECT_PATH: '/oauth-callback',
  PORTS: [8888, 8889, 8890, 8891, 8892],
  SCOPES: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  USERINFO_URL: 'https://www.googleapis.com/oauth2/v2/userinfo',
} as const;

// ── Antigravity Internal APIs ──
export const API = {
  LOAD_CODE_ASSIST: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  FETCH_CREDITS: 'https://cloudcode-pa.googleapis.com/v1internal:fetchCredits',
  DAILY_LOAD_CODE_ASSIST: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  FETCH_MODELS_URLS: [
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  ],
  QUOTA_SUMMARY_URLS: [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  ],
  DEFAULT_VERSION: '1.22.2',
} as const;

// ── Storage Keys ──
export const STORAGE_KEYS = {
  ACCOUNTS_LIST: 'antigravity.accounts.list',
  ACTIVE_ACCOUNT: 'antigravity.accounts.active',
  ALIASES: 'antigravity.accounts.aliases',
  LAST_REFRESH: 'antigravity.accounts.lastRefresh',
  SETTINGS: 'antigravity.settings',
  PREFERRED_MODEL: 'antigravity.settings.preferredModel',
  BALANCES_LAST_REFRESHED: 'antigravity.balances.lastRefreshedAt',
} as const;

// ── Secret Storage Key Prefixes ──
export const SECRET_KEYS = {
  REFRESH_TOKEN: (email: string) => `antigravity.account.${email}.refreshToken`,
  ACCESS_TOKEN: (email: string) => `antigravity.account.${email}.accessToken`,
  METADATA: (email: string) => `antigravity.account.${email}.metadata`,
} as const;

// ── State Database Keys ──
export const STATE_DB_KEYS = {
  OAUTH_TOKEN: 'antigravityUnifiedStateSync.oauthToken',
  USER_STATUS: 'antigravityUnifiedStateSync.userStatus',
  ENTERPRISE_PREFS: 'antigravityUnifiedStateSync.enterprisePreferences',
  AUTH_STATUS: 'antigravityAuthStatus',
  ONBOARDING: 'antigravityOnboarding',
  LEGACY: 'google.antigravity',
  /** Built-in Antigravity extension state blob (JSON) - holds agy onboarding data */
  EXTENSION_STATE: 'google.google-antigravity',
  TELEMETRY_SERVICE_MACHINE_ID: 'telemetry.serviceMachineId',
  STORAGE_SERVICE_MACHINE_ID: 'storage.serviceMachineId',
  TELEMETRY_FIRST_SESSION_DATE: 'telemetry.firstSessionDate',
  TELEMETRY_LAST_SESSION_DATE: 'telemetry.lastSessionDate',
  TELEMETRY_CURRENT_SESSION_DATE: 'telemetry.currentSessionDate',
} as const;

// ── Antigravity Agent Hub (agy) Credential ──
// Since the new Antigravity IDE, the agent backend (agy.exe --hub) no longer takes the
// account from state.vscdb. It loads its OAuth token from the OS keyring
// (Windows Credential Manager: target "gemini:antigravity", user "antigravity").
export const AGY_CREDENTIAL = {
  TARGET: 'gemini:antigravity',
  USER_NAME: 'antigravity',
  PROCESS_NAME: 'agy.exe',
  AUTH_METHOD_CONSUMER: 'consumer',
} as const;

// ── Keys inside the google.google-antigravity JSON blob ──
export const EXTENSION_STATE_KEYS = {
  STORAGE_ROOT: 'antigravity-storage',
  LAST_LOGIN_USERNAME: 'agy.onboarding.lastLoginUsername',
  LAST_LOGIN_IS_GCP_TOS: 'agy.onboarding.lastLoginIsGcpTos',
} as const;

// ── Protobuf Sentinel Keys ──
export const SENTINEL_KEYS = {
  OAUTH_TOKEN: 'oauthTokenInfoSentinelKey',
  USER_STATUS: 'userStatusSentinelKey',
  ENTERPRISE_PROJECT: 'enterpriseGcpProjectId',
} as const;

// ── Defaults ──
export const DEFAULTS = {
  REFRESH_INTERVAL_MS: 15 * 60 * 1000,
  LOW_CREDIT_THRESHOLD: 100,
  BUSY_TIMEOUT_MS: 3000,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 150,
} as const;

// ── Personal Email Domains (used to auto-detect is_gcp_tos) ──
export const PERSONAL_EMAIL_DOMAINS = [
  '@gmail.com',
  '@googlemail.com',
  '@outlook.com',
  '@hotmail.com',
  '@live.com',
  '@yahoo.com',
  '@icloud.com',
  '@me.com',
  '@aol.com',
  '@protonmail.com',
  '@proton.me',
  '@mail.com',
  '@yandex.com',
  '@zoho.com',
] as const;

// ── Storage.json Telemetry Keys ──
export const STORAGE_JSON_KEYS = {
  MACHINE_ID: 'telemetry.machineId',
  MAC_MACHINE_ID: 'telemetry.macMachineId',
  DEV_DEVICE_ID: 'telemetry.devDeviceId',
  SQM_ID: 'telemetry.sqmId',
  SERVICE_MACHINE_ID: 'storage.serviceMachineId',
} as const;
