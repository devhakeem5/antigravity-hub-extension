/**
 * Authentication Service
 * 
 * Orchestrates the complete OAuth2 flow:
 * 1. Generates Auth URL
 * 2. Opens the browser
 * 3. Captures the Auth Code via local server
 * 4. Exchanges the code for Access/Refresh Tokens
 * 5. Fetches the User Profile from Google
 */

import * as vscode from 'vscode';
import { Logger } from '../../core/utils/logger';
import { OAUTH } from '../../core/constants/app.constants';
import { OAuthServer } from './oauth.server';
import { I18nService } from '../../i18n/i18n.service';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface UserProfile {
  email: string;
  name: string;
  picture?: string;
}

export class AuthService {
  /**
   * Initiates the Google OAuth login process.
   * @returns Tokens and User Profile, or throws an error if authentication fails.
   */
  async login(): Promise<{ tokens: OAuthTokens; profile: UserProfile }> {
    const server = new OAuthServer();
    
    try {
      // 1. Start the temporary callback server
      const port = await server.start();
      const redirectUri = `http://localhost:${port}${OAUTH.REDIRECT_PATH}`;

      // 2. Build the precise OAuth URL
      const authUrl = new URL(OAUTH.AUTH_URL);
      authUrl.searchParams.append('client_id', OAUTH.CLIENT_ID);
      authUrl.searchParams.append('redirect_uri', redirectUri);
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('scope', OAUTH.SCOPES.join(' '));
      authUrl.searchParams.append('access_type', 'offline');
      
      // Force consent to guarantee we get a refresh_token every time
      authUrl.searchParams.append('prompt', 'consent'); 
      authUrl.searchParams.append('include_granted_scopes', 'true');

      // 3. Open the user's default browser
      Logger.getInstance().info(`Opening browser for OAuth on port ${port}...`);
      await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

      // 4. Wait for the user to complete the flow and capture the code
      const code = await server.waitForAuthCode();
      Logger.getInstance().info('OAuth code received successfully.');

      // 5. Exchange the authorization code for tokens
      const tokens = await this.exchangeCodeForTokens(code, redirectUri);
      
      // 6. Fetch basic user info (Email, Name)
      const profile = await this.fetchUserProfile(tokens.accessToken);

      Logger.getInstance().info(`Successfully authenticated user: ${profile.email}`);

      return { tokens, profile };
      
    } catch (error: any) {
      Logger.getInstance().error('Login flow failed', error);
      throw error;
    }
  }

  /**
   * Swaps the short-lived authorization code for actual tokens.
   */
  private async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: OAUTH.CLIENT_ID,
      client_secret: OAUTH.CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    try {
      const response = await fetch(OAUTH.TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as any;
      
      if (!data.refresh_token) {
        const i18n = I18nService.getInstance();
        throw new Error(i18n.t('authService.noRefreshToken'));
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in
      };
    } catch (error: any) {
      throw new Error(`Authentication token exchange failed: ${error.message}`);
    }
  }

  /**
   * Refreshes an expired access token using the stored refresh token.
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: OAUTH.CLIENT_ID,
      client_secret: OAUTH.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    try {
      const response = await fetch(OAUTH.TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed with status: ${response.status}`);
      }

      const data = await response.json() as any;
      
      return {
        accessToken: data.access_token,
        refreshToken: refreshToken, // The refresh token usually doesn't change, but we keep it
        expiresIn: data.expires_in
      };
    } catch (error: any) {
      Logger.getInstance().error('Error refreshing token', error);
      throw new Error(`Failed to refresh token: ${error.message}`);
    }
  }

  /**
   * Fetches the user's profile information from Google.
   */
  private async fetchUserProfile(accessToken: string): Promise<UserProfile> {
    try {
      const response = await fetch(OAUTH.USERINFO_URL, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`Profile fetch failed: ${response.status}`);
      }

      const data = await response.json() as any;
      
      if (!data.email) {
        const i18n = I18nService.getInstance();
        throw new Error(i18n.t('authService.noEmail'));
      }

      return {
        email: data.email,
        name: data.name || data.email.split('@')[0], // Fallback if name is empty
        picture: data.picture
      };
    } catch (error: any) {
      throw new Error(`Could not retrieve user profile: ${error.message}`);
    }
  }
}
