/**
 * Deriv New API (2024+) constants
 *
 * The NEW Deriv API uses OAuth 2.0 Authorization Code + PKCE.
 * App IDs registered at developers.deriv.com have alphanumeric format (e.g. "33EsxEGxJdpnIFRvtiSpY").
 *
 * OAuth flow:
 *   1. Generate PKCE (code_verifier + code_challenge + state)
 *   2. Redirect to DERIV_OAUTH_URL with client_id, redirect_uri, scope, state, code_challenge
 *   3. Deriv redirects back: {redirect_uri}?code=AUTH_CODE&state=STATE
 *   4. Exchange code → Bearer token: POST DERIV_TOKEN_URL with code + code_verifier
 *   5. Use Bearer token in all REST + WS calls
 *
 * WebSocket (trading):
 *   - Get OTP:     POST {DERIV_API_URL}/trading/v1/options/accounts/{accountId}/otp
 *   - Connect:     wss://api.derivws.com/trading/v1/options/ws/{type}?otp=...
 *   - Market data: wss://api.derivws.com/trading/v1/options/ws/public (no auth)
 */
export const DERIV_OAUTH_URL  = 'https://auth.deriv.com/oauth2/auth'
export const DERIV_TOKEN_URL  = 'https://auth.deriv.com/oauth2/token'
export const DERIV_API_URL    = 'https://api.derivws.com'

/** OAuth scopes for trading apps */
export const DERIV_SCOPE = 'trade account_manage'

/**
 * Legacy WebSocket (still used for public market data — ticks, candles, active symbols).
 * Does NOT require auth for public endpoints.
 */
export const DERIV_LEGACY_WS_URL = 'wss://ws.binaryws.com/websockets/v3'

/**
 * Affiliate signup link — earns commission when users create a Deriv account via Lima Trade.
 * Use this wherever a "Create account" / "Sign up" CTA appears.
 */
export const DERIV_AFFILIATE_URL = 'https://deriv.partners/rx?sidc=6D203A32-6635-4783-BB11-1296C141843C&utm_campaign=dynamicworks&utm_medium=affiliate&utm_source=CU83616'
