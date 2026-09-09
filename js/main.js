/**
 * main.js - boot: login screen, then connect + start the loop.
 */
import * as Nostr from './nostr.js';
import * as World from './world.js';
import * as Scene from './scene.js';
import * as UI from './ui.js';

const $ = (id) => document.getElementById(id);

function setStatus(text) { $('login-status').textContent = text; }

async function begin() {
    setStatus('Connecting to Cool Feeds relay…');
    try {
        await Nostr.connect();
    } catch {
        setStatus('Relay unreachable — exploring offline. Refresh to retry.');
    }

    // If logged in with NIP-07, pull our own profile for name + avatar,
    // and our contact list so follows get a ★ in the world.
    if (Nostr.identity.mainPk) {
        World.fetchFollows(Nostr.identity.mainPk);
        World.addHouse(Nostr.identity.mainPk); // your own house + garage + tank
        UI.toast('You have a house here — find it on the map, your tank is in the garage', 'success');
        Nostr.subscribe([{ kinds: [0], authors: [Nostr.identity.mainPk], limit: 1 }]);
        Nostr.on('event', (subId, ev) => {
            if (ev.kind === 0 && ev.pubkey === Nostr.identity.mainPk) {
                try {
                    const p = JSON.parse(ev.content);
                    Nostr.identity.name = p.display_name || p.name || Nostr.identity.name;
                    Nostr.identity.picture = p.picture || '';
                } catch { /* ignore */ }
            }
        });
    }

    World.start();
    $('login-screen').classList.add('hide');
    $('hud').classList.remove('hide');
    UI.toast('Welcome to Relay World! Walk to a building and press E to enter.', 'success');
}

function boot() {
    Scene.init($('world-canvas'));
    UI.init();

    $('login-nostr').addEventListener('click', async () => {
        try {
            setStatus('Asking your extension for a public key…');
            await Nostr.loginNip07();
            await begin();
        } catch (e) {
            setStatus(e.message);
        }
    });
    $('login-guest').addEventListener('click', () => begin());

    // #guest deep link: straight into the world, no login screen
    if (location.hash === '#guest') begin();

    // console/test handle — no UI, just state access
    window.__rw = { World, Scene, Nostr };

    let last = performance.now();
    function loop(now) {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        World.tick(dt, Date.now());
        Scene.update(dt);
        UI.frame();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

boot();
