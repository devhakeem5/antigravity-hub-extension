import { QuotaSummary, QuotaWindow } from '../domain/models/quota-summary.model';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function formatQuotaSummaryCompact(summary: QuotaSummary, t: Translate): string {
  if (!summary.length) {return t('statusBar.noQuotaData');}

  return summary.map(group => {
    const groupName = group.id === 'gemini'
      ? t('statusBar.geminiShort')
      : t('statusBar.claudeGptShort');
    const limits: string[] = [];
    if (group.weekly) {
      limits.push(`${t('statusBar.weeklyShort')} ${formatQuotaWindowValue(group.weekly, t)}`);
    }
    if (group.fiveHour) {
      limits.push(`${t('statusBar.fiveHourShort')} ${formatQuotaWindowValue(group.fiveHour, t)}`);
    }
    return `${groupName}: ${limits.join(' · ')}`;
  }).join(' | ');
}

export function formatQuotaSummaryDetailed(summary: QuotaSummary, t: Translate): string {
  if (!summary.length) {return t('statusBar.noQuotaData');}

  return summary.map(group => {
    const title = group.id === 'gemini'
      ? t('webview.geminiModels')
      : t('webview.claudeGptModels');
    const lines = [title];
    if (group.weekly) {
      lines.push(`  ${t('webview.weeklyLimitRemaining')}: ${formatQuotaWindowValue(group.weekly, t)}`);
    }
    if (group.fiveHour) {
      lines.push(`  ${t('webview.fiveHourLimitRemaining')}: ${formatQuotaWindowValue(group.fiveHour, t)}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

function formatQuotaWindowValue(window: QuotaWindow, t: Translate): string {
  if (window.remainingPercent > 0) {return `${window.remainingPercent}%`;}
  if (!window.resetTime) {return t('webview.limitReached');}

  const resetAt = new Date(window.resetTime).getTime();
  if (!Number.isFinite(resetAt)) {return t('webview.limitReached');}
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) {return t('webview.availableNow');}

  const totalMinutes = Math.max(1, Math.ceil(diffMs / (60 * 1000)));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0 && hours > 0) {
    return t('webview.renewsInDaysHoursMins', { days, hours, mins });
  }
  if (days > 0) {return t('webview.renewsInDaysMins', { days, mins });}
  return t('webview.renewsInHoursMins', { hours, mins });
}
