# latchkey-spotify

A [Latchkey](https://github.com/imbue-ai/latchkey) plugin that
adds Spotify as a service using its private API. The primary
purpose of this repository is to serve as an example of what
a Latchkey plugin looks like.  Use at your own risk.

## Installation

```bash
git clone https://github.com/imbue-ai/latchkey-spotify ~/.latchkey/plugins/spotify
```

## Usage

Log in through the browser:

```bash
latchkey auth browser spotify
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
