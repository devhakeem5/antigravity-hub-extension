/**
 * I18n Service — Internationalization Engine
 *
 * Provides a scalable localization system that:
 * - Loads locale files dynamically
 * - Supports nested key access (dot notation)
 * - Supports parameter interpolation {{param}}
 * - Falls back gracefully to the key itself if translation missing
 * - Allows adding new locales at runtime
 *
 * Architecture:
 * - Locale files are plain JSON objects stored in /i18n/locales/
 * - Adding a new language = adding a new JSON file + registering it
 * - No if/else or switch statements in UI code — just call i18n.t('key')
 */

import { Logger } from '../core/utils/logger';

/** Describes a registered locale */
export interface LocaleInfo {
  /** ISO language code (e.g., 'en', 'ar', 'fr') */
  code: string;
  /** Human-readable name (e.g., 'English', 'العربية') */
  name: string;
  /** Text direction */
  dir: 'ltr' | 'rtl';
}

/** Flat or nested translation dictionary */
interface TranslationDict {
  [key: string]: string | TranslationDict;
}

export class I18nService {
  private static instance: I18nService;

  /** Currently active locale code */
  private currentLocale: string = 'en';

  /** Registry: code → { info, translations } */
  private locales: Map<string, { info: LocaleInfo; translations: TranslationDict }> = new Map();

  /** Flattened cache for fast lookups: code → { 'a.b.c': 'value' } */
  private flatCache: Map<string, Record<string, string>> = new Map();

  private constructor() {
    // Register built-in locales
    this.registerBuiltInLocales();
  }

  static getInstance(): I18nService {
    if (!I18nService.instance) {
      I18nService.instance = new I18nService();
    }
    return I18nService.instance;
  }

  /**
   * Set the active locale.
   * Falls back to 'en' if the requested locale is not registered.
   */
  setLocale(code: string): void {
    if (!this.locales.has(code)) {
      Logger.getInstance().warn(`Locale '${code}' not found, falling back to 'en'`);
      code = 'en';
    }
    this.currentLocale = code;
  }

  /**
   * Get the current locale code.
   */
  getLocale(): string {
    return this.currentLocale;
  }

  /**
   * Get the current locale info (name, direction, etc.)
   */
  getLocaleInfo(): LocaleInfo {
    return this.locales.get(this.currentLocale)!.info;
  }

  /**
   * Get all registered locales.
   */
  getAvailableLocales(): LocaleInfo[] {
    return Array.from(this.locales.values()).map((entry) => entry.info);
  }

  /**
   * Translate a key with optional parameter interpolation.
   *
   * @param key - Dot-notation key (e.g., 'accounts.addButton.label')
   * @param params - Optional parameters for interpolation (e.g., { count: 5 })
   * @returns Translated string, or the key itself if not found
   *
   * @example
   * i18n.t('accounts.balance', { amount: '1850' })
   * // If translation is "Credits: {{amount}}" → returns "Credits: 1850"
   */
  t(key: string, params?: Record<string, string | number>): string {
    const flat = this.getFlatTranslations(this.currentLocale);
    let value = flat[key];

    if (value === undefined) {
      // Fallback to English
      if (this.currentLocale !== 'en') {
        const enFlat = this.getFlatTranslations('en');
        value = enFlat[key];
      }

      if (value === undefined) {
        Logger.getInstance().warn(`Missing translation key: '${key}' for locale '${this.currentLocale}'`);
        return key;
      }
    }

    // Interpolate parameters: {{paramName}}
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        value = value.replace(new RegExp(`\\{\\{${paramKey}\\}\\}`, 'g'), String(paramValue));
      }
    }

    return value;
  }

  /**
   * Register a new locale at runtime.
   * This is the extension point for adding new languages.
   *
   * @param info - Locale metadata
   * @param translations - Translation dictionary (can be nested)
   */
  registerLocale(info: LocaleInfo, translations: TranslationDict): void {
    this.locales.set(info.code, { info, translations });
    this.flatCache.delete(info.code); // Invalidate cache
    Logger.getInstance().info(`Locale registered: ${info.code} (${info.name})`);
  }

  /**
   * Check if a text direction is RTL for the current locale.
   */
  isRtl(): boolean {
    return this.getLocaleInfo().dir === 'rtl';
  }

  // ── Private Methods ──

  /**
   * Get flattened translations for a locale, using cache.
   */
  private getFlatTranslations(code: string): Record<string, string> {
    if (this.flatCache.has(code)) {
      return this.flatCache.get(code)!;
    }

    const entry = this.locales.get(code);
    if (!entry) {
      return {};
    }

    const flat = this.flattenObject(entry.translations);
    this.flatCache.set(code, flat);
    return flat;
  }

  /**
   * Flatten a nested object to dot-notation keys.
   * { a: { b: 'hello' } } → { 'a.b': 'hello' }
   */
  private flattenObject(
    obj: TranslationDict,
    prefix: string = ''
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof value === 'string') {
        result[fullKey] = value;
      } else {
        Object.assign(result, this.flattenObject(value, fullKey));
      }
    }

    return result;
  }

  /**
   * Register built-in locales (English + Arabic).
   */
  private registerBuiltInLocales(): void {
    // English
    this.registerLocale(
      { code: 'en', name: 'English', dir: 'ltr' },
      require('./locales/en.json')
    );

    // Arabic
    this.registerLocale(
      { code: 'ar', name: 'العربية', dir: 'rtl' },
      require('./locales/ar.json')
    );
  }
}
