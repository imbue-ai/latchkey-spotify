/**
 * Spotify, through the web player's own session.
 *
 * Spotify issues no personal API keys, and its official OAuth apps are gated
 * behind a paid plan. What every account does have is the web player at
 * open.spotify.com: after a login, the browser holds a long-lived `sp_dc`
 * session cookie (about a year), and the web player's JavaScript trades that
 * cookie for a short-lived bearer token (some ten minutes) at `/api/token`.
 * That exchange is protected by a time-based one-time code computed in the
 * page, so it cannot be replayed with plain HTTP: a browser has to run it.
 *
 * Hence:
 * - Login (`latchkey auth browser spotify`): the user signs into the web
 *   player, and the plugin reads `sp_dc` from the browser and captures the
 *   token the player mints when it loads.
 * - Injection: `Authorization: Bearer <token>` on requests to the web player's
 *   API host, spclient.wg.spotify.com. (The public api.spotify.com rate-limits
 *   web-player tokens.)
 * - Refresh: when a request finds the token expired, a headless browser loads
 *   the web player with `sp_dc` set and captures a fresh token. Nothing is
 *   minted while no requests are made.
 *
 * All of this rides Spotify's undocumented first-party web API, which is why
 * it is a plugin rather than a built-in service: Latchkey's own services stick
 * to documented public APIs. It can stop working whenever Spotify changes the
 * web player.
 *
 * Everything here is defined inside {@link createSpotify} because the classes
 * extend and use the ones handed over in the sdk: a plugin brings no copy of
 * Latchkey of its own.
 */
const LOGIN_URL = 'https://accounts.spotify.com/login';
const WEB_PLAYER_URL = 'https://open.spotify.com/';
const WEB_PLAYER_HOST = 'open.spotify.com';
const ACCOUNTS_HOST = 'accounts.spotify.com';
const TOKEN_URL_PREFIX = 'https://open.spotify.com/api/token';
const SESSION_COOKIE_NAME = 'sp_dc';
// All of the web player's data API (profile, playlists, library) lives on
// this host; other spclient hosts serve playback state.
const WEB_PLAYER_API_BASE_URL = 'https://spclient.wg.spotify.com/';
const PROFILE_URL = 'https://spclient.wg.spotify.com/user-profile-view/v3/profile/me';
// Paths on the web player host that a user may still be signed out on.
const PRE_LOGIN_PATH_PATTERN = /^\/(login|signup|signin|auth|sso|oauth|verify|mfa|otp)/i;
// The accounts site lands on a status page after a successful login when it
// does not redirect to the web player. Its path is prefixed with a locale.
const ACCOUNTS_LOGGED_IN_PATH_PATTERN = /\/status\/?$/;
// The web player mints its token as it starts up, typically within seconds.
const MINT_TIMEOUT_MS = 25_000;
// Tokens are re-minted this long before they actually expire, so a request
// that is about to go out does not hit the boundary.
const EXPIRY_MARGIN_MS = 60_000;
// Where the headless re-mint looks for a browser, in order: a system Chrome or
// Edge, then Playwright's own Chromium (which `latchkey ensure-browser`
// downloads when it finds no system browser).
const HEADLESS_BROWSER_CHANNELS = ['chrome', 'msedge', 'chromium'];
export class SpotifyTokenMintError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SpotifyTokenMintError';
    }
}
export class SpotifyBrowserUnavailableError extends Error {
    constructor(cause) {
        super('No browser could be launched to refresh the Spotify token ' +
            `(tried ${HEADLESS_BROWSER_CHANNELS.join(', ')}). ` +
            'Install Google Chrome, or run `latchkey ensure-browser` to download a browser.', { cause });
        this.name = 'SpotifyBrowserUnavailableError';
    }
}
/**
 * Whether a URL the browser reached is one only a signed-in user gets to.
 * Exported for the tests; the login flow itself goes through the session.
 */
export function isLoggedInUrl(url) {
    if (url.hostname === WEB_PLAYER_HOST) {
        return !PRE_LOGIN_PATH_PATTERN.test(url.pathname);
    }
    return url.hostname === ACCOUNTS_HOST && ACCOUNTS_LOGGED_IN_PATH_PATTERN.test(url.pathname);
}
export function createSpotify(sdk) {
    const { ApiCredentialsUsageError, BrowserFollowupServiceSession, FollowupWork, LoginFailedError, NoCurlCredentialsNotSupportedError, Service, z, } = sdk;
    // What `latchkey auth set-nocurl` reports to the user when it is handed
    // something other than the session cookie.
    class SpotifyCredentialArgumentsError extends NoCurlCredentialsNotSupportedError {
        constructor(message) {
            super('spotify');
            this.message = message;
            this.name = 'SpotifyCredentialArgumentsError';
        }
    }
    // ─── Credentials ────────────────────────────────────────────────────────────
    /**
     * Stored Spotify credentials: the durable `sp_dc` session cookie, plus the
     * short-lived access token last minted from it and when that token expires.
     * Fresh credentials hold no token yet; one is minted on first use.
     */
    const SpotifySessionCredentialsSchema = z.object({
        objectType: z.literal('spotifySession'),
        sessionCookie: z.string(),
        accessToken: z.string().optional(),
        accessTokenExpiresAt: z.string().datetime().optional(),
    });
    class SpotifySessionCredentials {
        sessionCookie;
        accessToken;
        accessTokenExpiresAt;
        static objectType = 'spotifySession';
        objectType = SpotifySessionCredentials.objectType;
        constructor(sessionCookie, accessToken, accessTokenExpiresAt) {
            this.sessionCookie = sessionCookie;
            this.accessToken = accessToken;
            this.accessTokenExpiresAt = accessTokenExpiresAt;
        }
        injectIntoCurlCall(curlArguments) {
            if (this.accessToken === undefined) {
                throw new ApiCredentialsUsageError('Spotify credentials hold no access token yet. One is minted from the session ' +
                    'cookie when a request is made.');
            }
            return Promise.resolve(['-H', `Authorization: Bearer ${this.accessToken}`, ...curlArguments]);
        }
        // Expired credentials are what Latchkey asks the service to refresh, so
        // credentials without a token count as expired too: minting one is the
        // refresh.
        isExpired() {
            if (this.accessToken === undefined || this.accessTokenExpiresAt === undefined) {
                return true;
            }
            return Date.now() >= new Date(this.accessTokenExpiresAt).getTime() - EXPIRY_MARGIN_MS;
        }
        toJSON() {
            return {
                objectType: this.objectType,
                sessionCookie: this.sessionCookie,
                accessToken: this.accessToken,
                accessTokenExpiresAt: this.accessTokenExpiresAt,
            };
        }
        static fromJSON(data) {
            const parsed = SpotifySessionCredentialsSchema.parse(data);
            return new SpotifySessionCredentials(parsed.sessionCookie, parsed.accessToken, parsed.accessTokenExpiresAt);
        }
    }
    // ─── Minting a token in a browser ───────────────────────────────────────────
    const TokenResponseSchema = z.object({
        accessToken: z.string(),
        accessTokenExpirationTimestampMs: z.number(),
        // What the web player gets when it is not signed in.
        isAnonymous: z.boolean().optional(),
    });
    async function readSessionCookie(context) {
        const cookies = await context.cookies(WEB_PLAYER_URL);
        return cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value ?? null;
    }
    /**
     * Load the web player in `page` and capture the token it mints on startup.
     * The page is always navigated (even when it already shows the web player)
     * because the mint happens as the player starts up.
     */
    async function mintAccessToken(page, sessionCookie) {
        let tokenResponse;
        try {
            [tokenResponse] = await Promise.all([
                page.waitForResponse((response) => response.url().startsWith(TOKEN_URL_PREFIX) && response.status() === 200, { timeout: MINT_TIMEOUT_MS }),
                page.goto(WEB_PLAYER_URL, { waitUntil: 'domcontentloaded' }),
            ]);
        }
        catch (error) {
            if (error instanceof Error && sdk.isTimeoutError(error)) {
                throw new SpotifyTokenMintError(`The Spotify web player did not request a token within ${String(MINT_TIMEOUT_MS / 1000)} s. ` +
                    'Either the session cookie has lapsed or Spotify changed the web player.');
            }
            throw error;
        }
        const body = TokenResponseSchema.safeParse(await tokenResponse.json().catch(() => null));
        if (!body.success) {
            throw new SpotifyTokenMintError('The Spotify web player returned a token response in an unexpected shape.');
        }
        if (body.data.isAnonymous === true) {
            throw new SpotifyTokenMintError('The Spotify session cookie is no longer valid: the web player minted an anonymous ' +
                'token. Log in again with `latchkey auth browser spotify`.');
        }
        return new SpotifySessionCredentials(sessionCookie, body.data.accessToken, new Date(body.data.accessTokenExpirationTimestampMs).toISOString());
    }
    /**
     * The browser Latchkey itself is configured with is not part of the sdk, so
     * the headless re-mint tries the browsers Playwright knows how to find.
     */
    async function launchHeadlessBrowser() {
        const { chromium } = await sdk.loadPlaywright();
        const failures = [];
        for (const channel of HEADLESS_BROWSER_CHANNELS) {
            try {
                return await chromium.launch({
                    channel,
                    headless: true,
                    // The same automation tells Latchkey strips for its own browser flows.
                    args: ['--disable-blink-features=AutomationControlled'],
                    ignoreDefaultArgs: ['--enable-automation'],
                });
            }
            catch (error) {
                failures.push(error);
            }
        }
        throw new SpotifyBrowserUnavailableError(failures);
    }
    // ─── Login ──────────────────────────────────────────────────────────────────
    /**
     * The user signs into the web player; the followup then reads the session
     * cookie and captures the token the player mints. Should that automation
     * break, the user is asked to paste the cookie by hand instead.
     */
    class SpotifyServiceSession extends BrowserFollowupServiceSession {
        followupWork = FollowupWork.RetrieveApiToken;
        manualCredentialForm = {
            instructions: `To finish by hand, open ${WEB_PLAYER_URL} in the other tab of this window, then copy ` +
                `the value of the ${SESSION_COOKIE_NAME} cookie from the browser's developer tools ` +
                `(Application, Cookies, ${WEB_PLAYER_URL}).`,
            fields: [
                {
                    name: 'sessionCookie',
                    label: `${SESSION_COOKIE_NAME} cookie`,
                    hint: 'The long value of the cookie, not its name.',
                },
            ],
            buildCredentials: (values) => new SpotifySessionCredentials(values.get('sessionCookie')),
        };
        isLoggedIn = false;
        onResponse(response) {
            if (response.request().resourceType() === 'document') {
                this.noteUrl(response.url());
            }
        }
        // The login is a single-page app whose route changes do not all produce
        // document responses, so the page's URL is checked between polls as well.
        whileWaitingForLogin(page) {
            this.noteUrl(page.url());
            return Promise.resolve();
        }
        noteUrl(rawUrl) {
            let url;
            try {
                url = new URL(rawUrl);
            }
            catch {
                return;
            }
            if (isLoggedInUrl(url)) {
                this.isLoggedIn = true;
            }
        }
        isLoginComplete() {
            return this.isLoggedIn;
        }
        async performBrowserFollowup(context) {
            const page = context.pages()[0];
            if (page === undefined) {
                throw new LoginFailedError('No page available after the Spotify login.');
            }
            const sessionCookie = await readSessionCookie(context);
            if (sessionCookie === null) {
                throw new LoginFailedError(`The Spotify login left no ${SESSION_COOKIE_NAME} cookie behind.`);
            }
            return await mintAccessToken(page, sessionCookie);
        }
    }
    // ─── Service ────────────────────────────────────────────────────────────────
    class Spotify extends Service {
        name = 'spotify';
        displayName = 'Spotify';
        baseApiUrls = [WEB_PLAYER_API_BASE_URL];
        loginUrl = LOGIN_URL;
        info = [
            `Spotify, through the web player's own API at ${WEB_PLAYER_API_BASE_URL} (undocumented).`,
            '',
            `Known endpoint: GET ${PROFILE_URL} returns the signed-in user's profile.`,
            '',
            "This relies on Spotify's first-party web client and may break when Spotify changes it.",
        ].join('\n');
        // A cheap read that only a valid token gets a 200 for.
        credentialCheckCurlArguments = [PROFILE_URL];
        // No getAccount: the cookie names no account, so `--account` names it
        // instead when a user has more than one.
        setCredentialsExample(serviceName) {
            return `latchkey auth set-nocurl ${serviceName} <${SESSION_COOKIE_NAME} cookie value>`;
        }
        getCredentialsNoCurl(noCurlArguments) {
            const [sessionCookie, ...unexpected] = noCurlArguments;
            if (sessionCookie === undefined || unexpected.length > 0) {
                throw new SpotifyCredentialArgumentsError(`Expected exactly one argument, the value of the ${SESSION_COOKIE_NAME} cookie. ` +
                    `Example: ${this.setCredentialsExample(this.name)}`);
            }
            return new SpotifySessionCredentials(sessionCookie);
        }
        getSession(appNamePrefix) {
            return new SpotifyServiceSession(this, appNamePrefix);
        }
        /**
         * Mint a fresh access token from the stored session cookie. Latchkey calls
         * this only when a request finds the token expired, so idle credentials
         * cost nothing.
         */
        async refreshCredentials(apiCredentials) {
            if (!(apiCredentials instanceof SpotifySessionCredentials)) {
                return null;
            }
            const browser = await launchHeadlessBrowser();
            try {
                const context = await browser.newContext();
                await context.addCookies([
                    {
                        name: SESSION_COOKIE_NAME,
                        value: apiCredentials.sessionCookie,
                        domain: '.spotify.com',
                        path: '/',
                        httpOnly: true,
                        secure: true,
                        sameSite: 'Lax',
                    },
                ]);
                return await mintAccessToken(await context.newPage(), apiCredentials.sessionCookie);
            }
            finally {
                await browser.close();
            }
        }
    }
    return { Spotify, SpotifySessionCredentials };
}
