import { QuotaGroup, QuotaGroupId, QuotaSummary, QuotaWindow, QuotaWindowId } from '../domain/models/quota-summary.model';

/** Normalizes Google's quota-summary response while tolerating minor JSON shape changes. */
export function parseQuotaSummaryResponse(data: unknown): QuotaSummary {
  const root = asRecord(data);
  const groups = asArray(root?.groups ?? asRecord(root?.response)?.groups);
  const parsed: QuotaSummary = [];

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) {continue;}
    const groupId = classifyGroup(group);
    if (!groupId) {continue;}

    const normalized: QuotaGroup = { id: groupId };
    for (const rawBucket of asArray(group.buckets)) {
      const bucket = asRecord(rawBucket);
      if (!bucket || bucket.disabled === true) {continue;}
      const windowId = classifyWindow(bucket);
      if (!windowId) {continue;}

      const remaining = readRemainingPercent(bucket);
      if (remaining === undefined) {continue;}
      const quotaWindow: QuotaWindow = {
        id: windowId,
        remainingPercent: remaining,
        resetTime: readResetTime(bucket.resetTime),
      };
      if (windowId === 'weekly') {normalized.weekly = quotaWindow;}
      else {normalized.fiveHour = quotaWindow;}
    }

    if (normalized.weekly || normalized.fiveHour) {parsed.push(normalized);}
  }

  return mergeDuplicateGroups(parsed);
}

/** Compatibility fallback for accounts cached before retrieveUserQuotaSummary was available. */
export function deriveQuotaSummaryFromBalances(balances: Record<string, unknown> | undefined): QuotaSummary {
  if (!balances) {return [];}
  const candidates = new Map<QuotaGroupId, Array<QuotaWindow & { durationMs?: number }>>();

  for (const [modelName, rawValue] of Object.entries(balances)) {
    const groupId = classifyModelName(modelName);
    const entry = asRecord(rawValue);
    if (!groupId || !entry || typeof entry.value !== 'number') {continue;}
    const resetTime = readResetTime(entry.resetTime);
    const durationMs = resetTime ? new Date(resetTime).getTime() - Date.now() : undefined;
    const windowId: QuotaWindowId = durationMs !== undefined && durationMs > 0 && durationMs <= 6 * 60 * 60 * 1000
      ? 'five-hour'
      : 'weekly';
    const list = candidates.get(groupId) || [];
    list.push({
      id: windowId,
      remainingPercent: clampPercent(entry.value),
      resetTime,
      durationMs,
    });
    candidates.set(groupId, list);
  }

  const result: QuotaSummary = [];
  for (const groupId of ['gemini', 'gemini-4', 'claude-gpt'] as const) {
    const entries = candidates.get(groupId) || [];
    if (!entries.length) {continue;}
    const group: QuotaGroup = { id: groupId };
    group.weekly = pickMostRestrictive(entries.filter(entry => entry.id === 'weekly'));
    group.fiveHour = pickMostRestrictive(entries.filter(entry => entry.id === 'five-hour'));
    if (group.weekly || group.fiveHour) {result.push(group);}
  }
  return result;
}

export function getLowestQuotaPercent(summary: QuotaSummary | undefined): number | undefined {
  const values = quotaPercentages(summary);
  return values.length ? Math.min(...values) : undefined;
}

export function getHighestQuotaPercent(summary: QuotaSummary | undefined): number | undefined {
  const values = quotaPercentages(summary);
  return values.length ? Math.max(...values) : undefined;
}

export interface QuotaSortMetrics {
  effectivePercent: number;
  hasFiveHour: boolean;
  weeklyPercent: number;
  /** Reset time (ms since epoch) for the weekly window, or Infinity if unknown. */
  weeklyResetMs: number;
}

/** Returns the values used to rank an account inside one quota group. */
export function getQuotaSortMetrics(
  summary: QuotaSummary | undefined,
  groupId: QuotaGroupId
): QuotaSortMetrics {
  const group = (summary || []).find(item => item.id === groupId);
  const weeklyPercent = group?.weekly?.remainingPercent ?? -1;
  const hasFiveHour = group?.fiveHour !== undefined;
  const effectiveWindow = group?.fiveHour ?? group?.weekly;
  const effectivePercent = effectiveWindow?.remainingPercent ?? -1;
  const weeklyResetMs = parseResetMs(group?.weekly?.resetTime);
  return {
    effectivePercent,
    hasFiveHour,
    weeklyPercent,
    weeklyResetMs,
  };
}

function parseResetMs(resetTime?: string): number {
  if (!resetTime) return Infinity;
  const ms = new Date(resetTime).getTime();
  return Number.isFinite(ms) ? ms : Infinity;
}

function quotaPercentages(summary: QuotaSummary | undefined): number[] {
  return (summary || []).flatMap(group => [group.weekly, group.fiveHour])
    .filter((window): window is QuotaWindow => !!window)
    .map(window => window.remainingPercent);
}

function classifyGroup(group: Record<string, unknown>): QuotaGroupId | undefined {
  const text = searchableText(group);
  if (/gemini\s*4|argon/i.test(text)) {return 'gemini-4';}
  if (text.includes('gemini')) {return 'gemini';}
  if (text.includes('claude') || text.includes('gpt') || text.includes('other model')) {return 'claude-gpt';}

  const bucketText = asArray(group.buckets).map(item => searchableText(asRecord(item))).join(' ');
  if (/gemini\s*4|argon/i.test(bucketText)) {return 'gemini-4';}
  if (bucketText.includes('gemini')) {return 'gemini';}
  if (bucketText.includes('claude') || bucketText.includes('gpt')) {return 'claude-gpt';}
  return undefined;
}

function classifyWindow(bucket: Record<string, unknown>): QuotaWindowId | undefined {
  const text = searchableText(bucket);
  if (/five.?hour|5.?hour|\b5h\b|18000/.test(text)) {return 'five-hour';}
  if (/weekly|week|\b7d\b|604800/.test(text)) {return 'weekly';}
  const durationSeconds = Number(asRecord(bucket.window)?.seconds);
  if (Number.isFinite(durationSeconds)) {
    if (durationSeconds > 0 && durationSeconds <= 6 * 60 * 60) {return 'five-hour';}
    if (durationSeconds >= 6 * 24 * 60 * 60) {return 'weekly';}
  }
  return undefined;
}

function classifyModelName(modelName: string): QuotaGroupId | undefined {
  const name = modelName.toLowerCase();
  if (/gemini[\s_-]*4|argon/.test(name)) {return 'gemini-4';}
  if (name.includes('gemini')) {return 'gemini';}
  if (name.includes('claude') || name.includes('gpt')) {return 'claude-gpt';}
  return undefined;
}

function readRemainingPercent(bucket: Record<string, unknown>): number | undefined {
  const nestedRemaining = asRecord(bucket.remaining);
  const value = bucket.remainingFraction
    ?? nestedRemaining?.remainingFraction;
  if (typeof value !== 'number' || !Number.isFinite(value)) {return undefined;}
  return clampPercent(value <= 1 ? value * 100 : value);
}

function readResetTime(value: unknown): string | undefined {
  if (typeof value === 'string') {return value;}
  const record = asRecord(value);
  if (!record) {return undefined;}
  if (typeof record.seconds === 'number' || typeof record.seconds === 'string') {
    const milliseconds = Number(record.seconds) * 1000;
    if (Number.isFinite(milliseconds)) {return new Date(milliseconds).toISOString();}
  }
  return undefined;
}

function pickMostRestrictive(entries: Array<QuotaWindow & { durationMs?: number }>): QuotaWindow | undefined {
  if (!entries.length) {return undefined;}
  const picked = [...entries].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
  return { id: picked.id, remainingPercent: picked.remainingPercent, resetTime: picked.resetTime };
}

function mergeDuplicateGroups(groups: QuotaSummary): QuotaSummary {
  const merged = new Map<QuotaGroupId, QuotaGroup>();
  for (const group of groups) {
    const current = merged.get(group.id) || { id: group.id };
    if (group.weekly) {current.weekly = group.weekly;}
    if (group.fiveHour) {current.fiveHour = group.fiveHour;}
    merged.set(group.id, current);
  }
  return ['gemini', 'gemini-4', 'claude-gpt'].flatMap(id => {
    const group = merged.get(id as QuotaGroupId);
    return group ? [group] : [];
  });
}

function searchableText(record: Record<string, unknown> | null): string {
  if (!record) {return '';}
  return [record.id, record.bucketId, record.displayName, record.description, record.window]
    .filter(value => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
