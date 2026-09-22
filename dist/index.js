/**
 * The plugin's entry point: what Latchkey imports from `~/.latchkey/plugins/<name>/`.
 *
 * A plugin is an ES module whose default export is a factory. Latchkey calls
 * it with the sdk (every class and helper a plugin may use, so that the plugin
 * needs no dependencies of its own) and gets back a manifest: the Latchkey
 * versions the plugin supports, its services, and the credentials classes its
 * services store.
 */
import { createSpotify } from './spotify.js';
const plugin = (sdk) => {
    const { Spotify, SpotifySessionCredentials } = createSpotify(sdk);
    return {
        latchkeyVersion: '^3.15.0',
        services: [new Spotify()],
        apiCredentialsTypes: [SpotifySessionCredentials],
    };
};
export default plugin;
