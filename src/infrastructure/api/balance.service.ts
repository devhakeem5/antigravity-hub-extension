/**
 * Balance & API Service
 * 
 * Interacts with Google's internal CloudCode/Antigravity APIs to extract
 * AI credit balances, plan types, and project metadata.
 * Implements a robust fallback strategy as these APIs are undocumented
 * and subject to occasional structure changes.
 */

import { ApiClient } from '../../core/network/api.client';
import { API } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';
import { AccountPlan } from '../../core/domain/models/account.model';

export interface BalanceResult {
  balances: Record<string, any>;
  plan: AccountPlan;
  projectId?: string;
  hasError: boolean;
}

export class BalanceService {
  /**
   * Orchestrates the fetching of credits and plan type for an account.
   * Executes multiple fallback strategies sequentially to guarantee reliability.
   */
  async getBalanceInfo(accessToken: string): Promise<BalanceResult> {
    const result: BalanceResult = {
      balances: {},
      plan: AccountPlan.UNKNOWN,
      hasError: false
    };

    try {
      // Strategy 1: Try Primary loadCodeAssist (Usually has all info)
      Logger.getInstance().debug('Attempting primary loadCodeAssist...');
      const codeAssist = await this.tryLoadCodeAssist(accessToken);
      
      if (codeAssist) {
        result.plan = this.parsePlanName(codeAssist.planName);
        result.projectId = codeAssist.projectId;
        
        if (codeAssist.balances && Object.keys(codeAssist.balances).length > 0) {
          result.balances = codeAssist.balances;
        }
      }

      // Strategy 2: Absolute fallback - try daily environment loadCodeAssist
      if (Object.keys(result.balances).length === 0) {
        Logger.getInstance().debug('Attempting fallback daily loadCodeAssist...');
        const fallbackCodeAssist = await this.tryFallbackLoadCodeAssist(accessToken);
        if (fallbackCodeAssist) {
          if (result.plan === AccountPlan.UNKNOWN) {
            result.plan = this.parsePlanName(fallbackCodeAssist.planName);
          }
          if (!result.projectId) {
            result.projectId = fallbackCodeAssist.projectId;
          }
          if (fallbackCodeAssist.balances && Object.keys(fallbackCodeAssist.balances).length > 0) {
            result.balances = fallbackCodeAssist.balances;
          }
        }
      }

      // Strategy 4: Fetch Available Models (Model percentages)
      Logger.getInstance().debug('Attempting to fetch available models...');
      const modelBalances = await this.tryFetchAvailableModels(accessToken, result.projectId);
      if (Object.keys(modelBalances).length > 0) {
        result.balances = { ...result.balances, ...modelBalances };
      }

      // Final Check
      if (Object.keys(result.balances).length === 0) {
        Logger.getInstance().warn('Could not extract credit balances from any API endpoints.');
        result.hasError = true;
      } else {
        Logger.getInstance().info(`Final balances retrieved: ${JSON.stringify(result.balances)}`);
      }

    } catch (error: any) {
      Logger.getInstance().error('Critical failure in getBalanceInfo', error);
      result.hasError = true;
    }

    return result;
  }

  // ─── Internal Strategies & Parsers ──────────────────────────────────────────

  private async tryLoadCodeAssist(accessToken: string): Promise<{ balances?: Record<string, number>, planName?: string, projectId?: string } | null> {
    try {
      const data = await ApiClient.request<any>(API.LOAD_CODE_ASSIST, {
        method: 'POST',
        body: { metadata: { ideType: 'ANTIGRAVITY' } },
        accessToken
      });
      
      const parsedData = this.parseCodeAssistData(data);
      
      if (parsedData && parsedData.balances) {
        for (const [modelName, balance] of Object.entries(parsedData.balances)) {
          Logger.getInstance().debug(`[tryLoadCodeAssist] Model: ${modelName}, Remaining Balance: ${balance}`);
        }
      }
      
      return parsedData;
    } catch (e) {
      Logger.getInstance().debug('Primary loadCodeAssist failed or returned 404');
      return null;
    }
  }


  private async tryFallbackLoadCodeAssist(accessToken: string) {
    try {
      // Note the difference in body payload structure for the daily API
      const data = await ApiClient.request<any>(API.DAILY_LOAD_CODE_ASSIST, {
        method: 'POST',
        body: {
          metadata: {
            ide_type: 'ANTIGRAVITY',
            ide_version: API.DEFAULT_VERSION,
            ide_name: 'antigravity'
          }
        },
        accessToken
      });
      return this.parseCodeAssistData(data);
    } catch (e) {
      Logger.getInstance().debug('Fallback loadCodeAssist failed');
      return null;
    }
  }

  private async tryFetchAvailableModels(accessToken: string, projectId?: string): Promise<Record<string, any>> {
    const balances: Record<string, any> = {};
    const body = projectId ? { project: projectId } : {};

    for (const url of API.FETCH_MODELS_URLS) {
      try {
        Logger.getInstance().debug(`Attempting fetchAvailableModels at ${url}...`);
        const data = await ApiClient.request<any>(url, {
          method: 'POST',
          body,
          accessToken
        });

        if (data && data.models) {
          for (const [modelId, modelData] of Object.entries<any>(data.models)) {
            if (modelData.quotaInfo) {
               const fraction = modelData.quotaInfo.remainingFraction !== undefined ? modelData.quotaInfo.remainingFraction : 0;
               balances[modelId] = {
                 value: Math.round(fraction * 100),
                 resetTime: modelData.quotaInfo.resetTime
               };
            }
          }
          if (Object.keys(balances).length > 0) {
             Logger.getInstance().info(`Successfully fetched model quotas from ${url}`);
             return balances;
          }
        }
      } catch (e) {
        Logger.getInstance().debug(`Failed to fetch models from ${url}`);
      }
    }
    
    return balances;
  }

  /**
   * Safely extracts credits, plan name, and project ID from the messy loadCodeAssist JSON response.
   */
  private parseCodeAssistData(data: any) {
    if (!data) return null;

    const balances: Record<string, number> = {};
    let planName: string | undefined;

    // Extract from paidTier if available
    if (data.paidTier) {
      planName = data.paidTier.name;
      const creditArray = data.paidTier.availableCredits;
      
      if (Array.isArray(creditArray) && creditArray.length > 0) {
        // Dynamically extract all available credits
        creditArray.forEach((c: any) => {
          // Attempt to find a suitable name/key
          const name = (c.creditType || c.modelName || c.modelId || c.id || c.name || 'default').toString().toLowerCase();
          
          // Attempt to find the amount
          let amountStr = c.creditAmount;
          if (amountStr === undefined) amountStr = c.amount || c.remaining || c.credits;
          
          // If omitted by Protobuf, it means the value is 0
          if (amountStr === undefined) amountStr = 0;
          
          const amount = parseInt(amountStr.toString(), 10);
          if (!isNaN(amount)) {
            balances[name] = amount;
          }
        });
      }
    }

    // Fallback to currentTier for plan name
    if (!planName && data.currentTier) {
      planName = data.currentTier.name;
    }

    return {
      balances: Object.keys(balances).length > 0 ? balances : undefined,
      planName,
      projectId: data.cloudaicompanionProject
    };
  }

  /**
   * Maps Google's internal string names to our clean Domain Enums.
   */
  private parsePlanName(name?: string): AccountPlan {
    if (!name) return AccountPlan.UNKNOWN;
    
    const lower = name.toLowerCase();
    
    if (lower.includes('ultra')) return AccountPlan.ULTRA;
    if (lower.includes('premium')) return AccountPlan.PREMIUM;
    if (lower.includes('free') || lower.includes('standard')) return AccountPlan.FREE;
    
    return AccountPlan.UNKNOWN;
  }
}
