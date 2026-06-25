/**
 * Deriv OAuth2 constants for third-party apps
 *
 * Register your app and get your App ID at:
 *   https://developers.deriv.com/docs/app-registration
 *
 * OAuth flow (third-party apps):
 *   1. Redirect user → DERIV_OAUTH_URL?app_id={DERIV_CLIENT_ID}&l=en&brand=deriv&redirect_uri={REDIRECT_URI}
 *   2. After login Deriv redirects to: {REDIRECT_URI}?token1=TOKEN&acct1=LOGINID&cur1=USD
 *      (multiple accounts: &token2=...&acct2=...&cur2=...)
 *   3. Use the token directly: WS → { authorize: token1 }
 *
 * NOTE: DERIV_CLIENT_ID is the App ID shown in your app details on developers.deriv.com.
 */
export const DERIV_OAUTH_URL = 'https://oauth.deriv.com/oauth2/authorize'
export const DERIV_WS_URL    = 'wss://ws.binaryws.com/websockets/v3'
