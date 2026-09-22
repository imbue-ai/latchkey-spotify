import { describe, expect, it } from 'vitest';
import type { BrowserFollowupServiceSession } from 'latchkey/plugin';
import { createLatchkeySdk } from 'latchkey/dist/src/pluginSdk.js';
import plugin from '../src/index.js';
import { isLoggedInUrl } from '../src/spotify.js';

// What Latchkey hands the plugin at load time, for a Latchkey of this version.
const sdk = createLatchkeySdk('3.15.0');
const manifest = await plugin(sdk);
const [spotify] = manifest.services;
const [SpotifySessionCredentials] = manifest.apiCredentialsTypes ?? [];

const SESSION_COOKIE = 'AQB-session-cookie';
const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();

function credentialsWithToken(token: string, expiresAt = IN_AN_HOUR) {
  return SpotifySessionCredentials!.fromJSON({
    objectType: 'spotifySession',
    sessionCookie: SESSION_COOKIE,
    accessToken: token,
    accessTokenExpiresAt: expiresAt,
  });
}

describe('the plugin manifest', () => {
  it('provides the spotify service, built from the sdk', () => {
    expect(spotify).toBeInstanceOf(sdk.Service);
    expect(spotify!.name).toBe('spotify');
    expect(spotify!.baseApiUrls).toEqual(['https://spclient.wg.spotify.com/']);
  });

  it('registers the credentials class its service stores', () => {
    expect(SpotifySessionCredentials!.objectType).toBe('spotifySession');
  });
});

describe('SpotifySessionCredentials', () => {
  it('survives a round trip through JSON', () => {
    const credentials = credentialsWithToken('t0ken');

    expect(SpotifySessionCredentials!.fromJSON(credentials.toJSON!())).toEqual(credentials);
  });

  it('refuses stored data it does not understand', () => {
    expect(() =>
      SpotifySessionCredentials!.fromJSON({ objectType: 'spotifySession', accessToken: 't' })
    ).toThrow();
  });

  it('injects the access token as a bearer header', async () => {
    const credentials = credentialsWithToken('t0ken');

    expect(await credentials.injectIntoCurlCall(['https://spclient.wg.spotify.com/x'])).toEqual([
      '-H',
      'Authorization: Bearer t0ken',
      'https://spclient.wg.spotify.com/x',
    ]);
  });

  it('cannot be injected before a token has been minted', () => {
    const credentials = spotify!.getCredentialsNoCurl([SESSION_COOKIE]);

    expect(() => credentials.injectIntoCurlCall([])).toThrow(sdk.ApiCredentialsUsageError);
  });

  it('counts as expired until a token has been minted, so that Latchkey asks for one', () => {
    expect(spotify!.getCredentialsNoCurl([SESSION_COOKIE]).isExpired()).toBe(true);
  });

  it('is valid while the token has more than a minute left', () => {
    expect(credentialsWithToken('t').isExpired()).toBe(false);
  });

  it('expires a minute early', () => {
    const inThirtySeconds = new Date(Date.now() + 30_000).toISOString();

    expect(credentialsWithToken('t', inThirtySeconds).isExpired()).toBe(true);
  });
});

describe('Spotify service', () => {
  it('takes the session cookie as the single set-nocurl argument', () => {
    const credentials = spotify!.getCredentialsNoCurl([SESSION_COOKIE]);

    expect(credentials.toJSON!()).toEqual({
      objectType: 'spotifySession',
      sessionCookie: SESSION_COOKIE,
    });
  });

  it.each([[[]], [['one', 'two']]])('rejects set-nocurl arguments %j', (noCurlArguments) => {
    expect(() => spotify!.getCredentialsNoCurl(noCurlArguments)).toThrow(
      sdk.NoCurlCredentialsNotSupportedError
    );
  });

  it('does not refresh credentials of another type', async () => {
    expect(await spotify!.refreshCredentials!(new sdk.AuthorizationBearer('t'))).toBeNull();
  });

  it('offers a manual form that builds credentials from a pasted cookie', () => {
    const session = spotify!.getSession!('Latchkey') as BrowserFollowupServiceSession;
    const values = new sdk.CredentialFormValues(new Map([['sessionCookie', SESSION_COOKIE]]));

    const credentials = session.manualCredentialForm!.buildCredentials(values);

    expect(credentials.toJSON!()).toEqual({
      objectType: 'spotifySession',
      sessionCookie: SESSION_COOKIE,
    });
  });
});

describe('isLoggedInUrl', () => {
  it.each([
    'https://open.spotify.com/',
    'https://open.spotify.com/collection/tracks',
    'https://accounts.spotify.com/en/status',
    'https://accounts.spotify.com/cs-CZ/status/',
  ])('treats %s as signed in', (url) => {
    expect(isLoggedInUrl(new URL(url))).toBe(true);
  });

  it.each([
    'https://accounts.spotify.com/en/login',
    'https://accounts.spotify.com/en/login/password',
    'https://open.spotify.com/login',
    'https://open.spotify.com/signup',
    'https://www.spotify.com/',
  ])('does not treat %s as signed in', (url) => {
    expect(isLoggedInUrl(new URL(url))).toBe(false);
  });
});
