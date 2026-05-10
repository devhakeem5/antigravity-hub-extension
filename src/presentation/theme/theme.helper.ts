/**
 * Theme Helper
 * 
 * Provides utilities for injecting the global theme and RTL direction
 * into Webview HTML content.
 */

import * as vscode from 'vscode';
import { I18nService } from '../../i18n/i18n.service';

export class ThemeHelper {
    /**
     * Generates the base HTML wrapper for Webviews, automatically injecting
     * the global CSS, CSP (Content Security Policy), and localization direction (LTR/RTL).
     * 
     * @param webview - The VS Code Webview instance
     * @param extensionUri - URI of the extension to resolve local assets
     * @param content - The specific HTML content to wrap
     * @param title - The page title
     * @returns Complete HTML string
     */
    static getWebviewHtml(
        webview: vscode.Webview, 
        extensionUri: vscode.Uri, 
        content: string, 
        title: string
    ): string {
        const i18n = I18nService.getInstance();
        const isRtl = i18n.isRtl();
        const dir = isRtl ? 'rtl' : 'ltr';
        
        // Resolve path to our global theme CSS
        const themeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'src', 'presentation', 'theme', 'global.css')
        );

        // Content Security Policy to ensure security inside Webview
        const cspSource = webview.cspSource;
        const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-webview'; img-src ${cspSource} https:;`;

        return `<!DOCTYPE html>
<html lang="${i18n.getLocale()}" dir="${dir}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>${title}</title>
    
    <!-- Inject Global Theme -->
    <link href="${themeUri}" rel="stylesheet" />
    
    <!-- Optional: Inject VS Code default styles as fallback or base -->
    <style>
        /* Add any dynamic CSS overrides here if needed */
    </style>
</head>
<body dir="${dir}">
    ${content}
</body>
</html>`;
    }
}
