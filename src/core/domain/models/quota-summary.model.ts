export type QuotaGroupId = 'gemini' | 'claude-gpt';
export type QuotaWindowId = 'weekly' | 'five-hour';

export interface QuotaWindow {
  id: QuotaWindowId;
  remainingPercent: number;
  resetTime?: string;
}

export interface QuotaGroup {
  id: QuotaGroupId;
  weekly?: QuotaWindow;
  fiveHour?: QuotaWindow;
}

export type QuotaSummary = QuotaGroup[];
