# latchkey-spotify

A [Latchkey](https://github.com/imbue-ai/latchkey) plugin that adds
Spotify as a service, through the Spotify web player's own session.

It also serves as an example of what a Latchkey plugin looks like. If
you are here to write one of your own, skip to
[Anatomy of a plugin](#anatomy-of-a-plugin).

## Why a plugin?

Spotify issues no personal API keys, and its official OAuth apps are
gated behind a paid plan. What every account does have is the web
player at open.spotify.com. This plugin rides on that: it captures the
web player's long-lived session cookie and mints the short-lived
access tokens the player itself uses.

That means talking to Spotify's undocumented first-party web API. The
services built into Latchkey stick to documented public APIs by
policy, so this connector lives in a plugin instead.

Beware: this can stop working whenever Spotify changes the web player,
and automated access may be at odds with Spotify's terms of service.

## Installation

Requires Latchkey 3.15.0 or newer. A plugin is a git repository cloned
into Latchkey's plugins directory:

```bash
git clone https://github.com/imbue-ai/latchkey-spotify ~/.latchkey/plugins/spotify
```

That is the whole installation. Latchkey loads the plugin the next
time it starts:

```bash
latchkey services info spotify
```

To uninstall, delete the directory again.

## Usage

Log in through the browser:

```bash
latchkey auth browser spotify
```

Or paste the `sp_dc` cookie of a web player session you are already
signed into (find it in your browser's developer tools under
Application, Cookies, https://open.spotify.com):

```bash
latchkey auth set-nocurl spotify <sp_dc cookie value>
```

Then call the web player's API as usual:

```bash
latchkey curl https://spclient.wg.spotify.com/user-profile-view/v3/profile/me
```

Requests go to `spclient.wg.spotify.com`, the host the web player
itself talks to. The public `api.spotify.com` rate-limits web-player
tokens.

Spotify cannot tell Latchkey which account a session cookie belongs
to, so a login is stored under the default account unless you name one
with `latchkey --account <name> auth browser spotify`.

## How it works

- **Login.** You sign into the web player in the browser Latchkey
  opens. Once you are through, the plugin reads the `sp_dc` cookie
  from the browser and captures the access token the web player mints
  as it loads. If that automation breaks, the browser stays open and
  asks you to paste the cookie by hand.
- **Requests.** The access token is injected as
  `Authorization: Bearer <token>`.
- **Refresh.** Access tokens live for some ten minutes. When a request
  finds the token expired, the plugin launches a headless browser with
  the `sp_dc` cookie set, loads the web player, and captures the fresh
  token it mints. Nothing is minted while no requests are made. The
  exchange is protected by a one-time code computed by the web player's
  JavaScript, which is why a browser has to run it. The headless browser
  is a system Chrome or Edge if one is installed, otherwise the Chromium
  that `latchkey ensure-browser` downloads.
- **Storage.** The cookie, the token and its expiry are stored together
  as credentials of the plugin's own type, `spotifySession`, in
  Latchkey's encrypted credential store.

## Anatomy of a plugin

A plugin is an ES module package. Latchkey imports the entry named by
`main` (or `exports`) in `package.json`, falling back to `index.js`,
and expects its default export to be a factory:

```js
export default (sdk) => ({
  latchkeyVersion: '^3.15.0',
  services: [new Spotify()],
  apiCredentialsTypes: [SpotifySessionCredentials],
});
```

- **`sdk`** carries everything a plugin may use: the `Service` base
  classes, the built-in credentials classes, error classes, browser
  and OAuth helpers, `zod`, and so on. A plugin extends and calls what
  it finds there instead of importing Latchkey itself, so a bare
  `git clone` with no `node_modules` is a complete installation.
  Services have to extend `sdk.Service`; a class from a separately
  installed copy of Latchkey is refused.
- **`latchkeyVersion`** is the range of Latchkey versions the plugin
  was written for, in `package.json` dependency syntax. The sdk
  follows semantic versioning, so `^3.15.0` means 3.15.0 or newer
  until the next major version. Latchkey refuses to load a plugin
  whose range excludes it.
- **`services`** are instances of `sdk.Service` subclasses. Once
  loaded, they are indistinguishable from the built-in ones.
- **`apiCredentialsTypes`** lists the credentials classes the
  plugin's services store, when they are not one of the built-in ones.
  Such a class has a static `objectType` naming the stored type and a
  static `fromJSON` that validates stored data and rebuilds the
  credentials.

In this repository:

- [`src/index.ts`](src/index.ts) is the factory.
- [`src/spotify.ts`](src/spotify.ts) defines the credentials class, the
  login session, and the service. Everything sits inside a function
  that takes the sdk, because the classes extend the ones the sdk
  provides.
- [`tests/spotify.test.ts`](tests/spotify.test.ts) exercises the plugin
  against a real sdk object.

For types, a plugin depends on `latchkey` at development time only and
imports them from `latchkey/plugin`:

```ts
import type { LatchkeySdk, LatchkeyPluginFactory, Page } from 'latchkey/plugin';
```

Type-only imports vanish from the compiled JavaScript, which keeps the
built plugin free of dependencies.

## Development

```bash
npm install
npm run build      # compiles src/ into dist/, which is what Latchkey loads
npm test
npm run lint
```

`dist/` is committed on purpose: Latchkey loads the built JavaScript,
and a plugin has to work straight out of `git clone`. Rebuild and
commit `dist/` together with any change to `src/`.

To try a checkout without cloning it into place, symlink it:

```bash
ln -s "$(pwd)" ~/.latchkey/plugins/spotify
```

## License

MIT
