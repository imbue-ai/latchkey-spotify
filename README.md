# latchkey-spotify

A [Latchkey](https://github.com/imbue-ai/latchkey) plugin that
adds Spotify as a service using its private API. The primary
purpose of this repository is to serve as an example of what
a Latchkey plugin looks like. Use at your own risk.

(Originally contributed [here](https://github.com/imbue-ai/latchkey/pull/125).)

## Installation

```bash
git clone https://github.com/imbue-ai/latchkey-spotify ~/.latchkey/plugins/spotify
```

## Usage

Log in through the browser:

```bash
latchkey auth browser spotify
```

Then call the web player's own APIs as usual. The signed-in user's own
profile comes from the web player's GraphQL API:

```bash
latchkey curl -X POST https://api-partner.spotify.com/pathfinder/v2/query \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -H 'app-platform: WebPlayer' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:159.0) Gecko/20100101 Firefox/159.0' \
  --data-raw '{"variables":{},"operationName":"profileAttributes","extensions":{"persistedQuery":{"version":1,"sha256Hash":"08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0"}}}'
```

The username is at `data.me.profile.username`. Requests to
`api-partner.spotify.com` need a browser `User-Agent`: with curl's
default one, Spotify answers `403 Client/request not allowed`. The
`sha256Hash` names the query on Spotify's side and changes when the web
player ships a new version of it.

Everything else (profiles, playlists, library) is on
`spclient.wg.spotify.com`, the host the web player itself talks to:

```bash
latchkey curl https://spclient.wg.spotify.com/user-profile-view/v3/profile/<username>
```

Note that `.../profile/<username>` takes a literal username:
`.../profile/me` is the public profile of the user whose username is
`me`, not yours. The public `api.spotify.com` rate-limits web-player
tokens.

A login is stored under the signed-in user's Spotify username, read
with the query above. Name an account yourself with
`latchkey --account <name> auth browser spotify`.


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
