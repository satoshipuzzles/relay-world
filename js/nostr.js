/**
 * nostr.js - single-relay client for Relay World
 *
 * One WebSocket to the Cool Feeds relay. A throwaway session key signs all
 * game traffic (presence, chat) so a NIP-07 user is prompted exactly once —
 * for their pubkey at login — and never again while playing.
 */
import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';
import { CONFIG } from './config.js';

const listeners = { event: [], status: [] };
let ws = null;
let openPromise = null;
let subSerial = 0;
const liveSubs = new Map(); // subId -> filters, replayed on reconnect

export const identity = {
    sessionSk: generateSecretKey(),
    sessionPk: '',
    mainPk: null,     // NIP-07 pubkey, if logged in
    name: '',
    picture: '',
};
identity.sessionPk = getPublicKey(identity.sessionSk);
identity.name = 'Wanderer-' + identity.sessionPk.slice(0, 4);

export function npub(pk) {
    try { return nip19.npubEncode(pk); } catch { return pk; }
}

export function shortNpub(pk) {
    const n = npub(pk);
    return n.slice(0, 12) + '…' + n.slice(-4);
}

export function on(type, fn) { listeners[type].push(fn); }
function emit(type, ...args) { for (const fn of listeners[type]) fn(...args); }

export function connect() {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
        const url = CONFIG.RELAY;
        const sock = new WebSocket(url);
        const timer = setTimeout(() => { sock.close(); reject(new Error('relay timeout')); }, 8000);
        sock.onopen = () => {
            clearTimeout(timer);
            ws = sock;
            emit('status', 'open');
            for (const [id, filters] of liveSubs) send(['REQ', id, ...filters]);
            resolve();
        };
        sock.onmessage = (msg) => {
            let data;
            try { data = JSON.parse(msg.data); } catch { return; }
            if (data[0] === 'EVENT') emit('event', data[1], data[2]);
        };
        sock.onclose = () => {
            ws = null;
            openPromise = null;
            emit('status', 'closed');
            setTimeout(() => connect().catch(() => {}), 2000 + Math.random() * 3000);
        };
        sock.onerror = () => { /* onclose follows */ };
    });
    return openPromise;
}

function send(arr) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(arr));
}

export function subscribe(filters) {
    const id = 'rw' + (++subSerial);
    liveSubs.set(id, filters);
    send(['REQ', id, ...filters]);
    return id;
}

export function publish(kind, content, tags = []) {
    const event = finalizeEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', CONFIG.TAG], ...tags],
        content,
    }, identity.sessionSk);
    send(['EVENT', event]);
    return event;
}

/** NIP-07 login: one prompt for the pubkey, nothing else. */
export async function loginNip07() {
    if (!window.nostr || typeof window.nostr.getPublicKey !== 'function') {
        throw new Error('No Nostr extension found. Try guest mode.');
    }
    const pk = await window.nostr.getPublicKey();
    identity.mainPk = pk;
    identity.name = shortNpub(pk);
    return pk;
}
