/**
 * Deriv Legacy OAuth + WebSocket constants
 *
 * Lima Trade uses the proven legacy Deriv OAuth flow (oauth.deriv.com).
 * This is the system used by all documented Deriv third-party apps.
 *
 * OAuth flow:
 *   1. Redirect to DERIV_OAUTH_URL with app_id
 *   2. User logs in on Deriv
 *   3. Deriv redirects back: {redirect_uri}?acct1=CR...&token1=a1-...&cur1=USD&acct2=...
 *   4. Parse tokens and save to session
 *   5. Connect to DERIV_LEGACY_WS_URL?app_id=APP_ID, send { authorize: "a1-..." }
 *
 * App registration:
 *   - Go to https://api.deriv.com/dashboard → Applications
 *   - Create or find your app → copy the numeric App ID (e.g. 12345)
 *   - Set OAuth Redirect URL to: https://YOUR-DOMAIN.vercel.app/callback
 *   - Set DERIV_CLIENT_ID env var to the numeric App ID
 */
export const DERIV_OAUTH_URL = 'https://oauth.deriv.com/oauth2/authorize'

/**
 * WebSocket for ALL trading and market data.
 * Requires { authorize: "a1-..." } after connect for authenticated endpoints.
 * Public ticks also need app_id in URL: ?app_id=YOUR_NUMERIC_APP_ID
 */
export const DERIV_LEGACY_WS_URL = 'wss://ws.binaryws.com/websockets/v3'

/**
 * Affiliate signup link — earns commission when users create a Deriv account via Lima Trade.
 * Use this wherever a "Create account" / "Sign up" CTA appears.
 */
export const DERIV_AFFILIATE_URL = 'https://deriv.partners/rx?sidc=6D203A32-6635-4783-BB11-1296C141843C&utm_campaign=dynamicworks&utm_medium=affiliate&utm_source=CU83616'
