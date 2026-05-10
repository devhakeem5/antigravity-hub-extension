/**
 * OAuth Local Server
 * 
 * Spins up a temporary local HTTP server to receive the OAuth2 callback
 * from Google. It tries a list of ports sequentially until it finds an open one.
 * Once the code is received, it serves a stylized success HTML page and closes.
 */

import * as http from 'http';
import * as url from 'url';
import { Logger } from '../../core/utils/logger';
import { OAUTH } from '../../core/constants/app.constants';
import { I18nService } from '../../i18n/i18n.service';

export class OAuthServer {
  private server: http.Server | null = null;
  private currentPort: number | null = null;

  /**
   * Starts the server on the first available port from the configured list.
   * @returns The port number the server is listening on.
   */
  async start(): Promise<number> {
    this.server = http.createServer();
    this.currentPort = await this.listenOnAvailablePort(OAUTH.PORTS, 0);
    Logger.getInstance().info(`OAuth Server started successfully on port ${this.currentPort}`);
    return this.currentPort;
  }

  /**
   * Listens for the OAuth callback request and extracts the authorization code.
   * Resolves when the code is received, or rejects if it times out.
   * Automatically closes the server upon completion.
   */
  async waitForAuthCode(timeoutMs: number = 5 * 60 * 1000): Promise<string> {
    const i18n = I18nService.getInstance();
    if (!this.server) {
      throw new Error('OAuth Server has not been started.');
    }

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (this.server) {
          this.server.close();
          this.server = null;
        }
      };

      // Set timeout to prevent the server from running indefinitely
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(i18n.t('oauth.timeout')));
      }, timeoutMs);

      this.server!.on('request', (req, res) => {
        const reqUrl = url.parse(req.url || '', true);
        
        // Only handle the specific redirect path
        if (reqUrl.pathname === OAUTH.REDIRECT_PATH) {
          const code = reqUrl.query.code as string;
          const error = reqUrl.query.error as string;

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getHtmlResponse(i18n.t('oauth.authFailedTitle'), i18n.t('oauth.authFailedDetail', { error }), false));
            cleanup();
            reject(new Error(`OAuth Error: ${error}`));
            return;
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getHtmlResponse(i18n.t('oauth.authSuccessTitle'), i18n.t('oauth.authSuccessDetail'), true));
            cleanup();
            resolve(code);
            return;
          }
        } else {
          // Return 404 for any other rogue requests (like favicon.ico)
          res.writeHead(404);
          res.end();
        }
      });
    });
  }

  /**
   * Recursively tries ports until it successfully binds.
   */
  private listenOnAvailablePort(ports: readonly number[], index: number): Promise<number> {
    return new Promise((resolve, reject) => {
      if (index >= ports.length) {
        const i18n = I18nService.getInstance();
        return reject(new Error(i18n.t('oauth.noPorts')));
      }

      const port = ports[index];
      
      this.server!.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          Logger.getInstance().warn(`Port ${port} is in use, trying next port...`);
          resolve(this.listenOnAvailablePort(ports, index + 1));
        } else {
          reject(err);
        }
      });

      this.server!.listen(port, '127.0.0.1', () => {
        // Successfully bound
        this.server!.removeAllListeners('error');
        resolve(port);
      });
    });
  }

  /**
   * Generates a beautifully styled HTML response page that aligns with the extension's theme.
   */
  private getHtmlResponse(title: string, message: string, isSuccess: boolean): string {
    const color = isSuccess ? '#22c55e' : '#ef4444'; // Green for success, Red for error
    const icon = isSuccess ? '✅' : '❌';
    
    return `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Antigravity Hub - Authentication</title>
        <style>
          body {
            background-color: #110c18;
            color: #faf5ff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
          }
          .container {
            background-color: #1e152a;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5), 0 0 15px rgba(107, 33, 168, 0.3);
            text-align: center;
            border-top: 4px solid ${color};
            max-width: 450px;
            width: 100%;
          }
          h1 { 
            color: ${color}; 
            margin-bottom: 15px; 
            font-size: 1.8rem;
          }
          p { 
            color: #d8b4fe; 
            font-size: 1.1rem; 
            line-height: 1.6; 
            margin-bottom: 30px;
          }
          .icon { 
            font-size: 4.5rem; 
            margin-bottom: 20px; 
            display: inline-block;
            animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
          }
          .btn {
            background-color: #6b21a8;
            color: white;
            border: none;
            padding: 10px 24px;
            border-radius: 6px;
            font-size: 1rem;
            cursor: pointer;
            transition: background-color 0.2s;
            text-decoration: none;
            display: inline-block;
          }
          .btn:hover {
            background-color: #9333ea;
          }
          @keyframes popIn {
            0% { transform: scale(0); opacity: 0; }
            100% { transform: scale(1); opacity: 1; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">${icon}</div>
          <h1>${title}</h1>
          <p>${message}</p>
          <button class="btn" onclick="window.close()">${I18nService.getInstance().t('oauth.closeWindow')}</button>
        </div>
        <script>
          // Attempt to auto-close the window after 3 seconds on success
          if (${isSuccess}) {
            setTimeout(() => {
              try { window.close(); } catch(e) {}
            }, 3000);
          }
        </script>
      </body>
      </html>
    `;
  }
}
