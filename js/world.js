/**
 * world.js - game state: the local player, feed NPCs, remote players, chat.
 *
 * NPCs are real npubs pulled off the Cool Feeds relay. Each author gets a
 * deterministic home spot (hashed from their pubkey) and wanders around it,
 * carrying their latest note as a speech bubble.
 */
import { CONFIG, BUILDINGS } from './config.js';
import * as Nostr from './nostr.js';

export const self = {
    x: 0, z: 12, ry: Math.PI, // facing the buildings
    vx: 0, vz: 0,
    moving: false,
    inside: null, // building id when indoors
};

export const npcs = new Map();     // pubkey -> npc
export const players = new Map();  // session pubkey -> remote player
export const profiles = new Map(); // pubkey -> kind0 profile
export const feedNotes = [];       // newest-first kind1 events (for the feed hall)
export const chatLog = [];         // {name, text, ts, self}
export const follows = new Set();  // pubkeys the logged-in user follows (kind 3)

const events = { chat: [], npc: [], note: [], reset: [] };
export function on(type, fn) { events[type].push(fn); }
function emit(type, ...a) { for (const fn of events[type]) fn(...a); }

// --- deterministic placement -------------------------------------------------

function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function insideBuilding(x, z, pad = 4) {
    return BUILDINGS.find(b =>
        x > b.x - b.w / 2 - pad && x < b.x + b.w / 2 + pad &&
        z > b.z - b.d / 2 - pad && z < b.z + b.d / 2 + pad);
}

function homeFor(pubkey) {
    const h = hash32(pubkey);
    // Spread across the plaza and streets, never inside a building footprint.
    for (let attempt = 0; attempt < 8; attempt++) {
        const hx = hash32(pubkey + ':' + attempt);
        const r = 15 + (h % 1000) / 1000 * 120;
        const a = (hx % 6283) / 1000;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r * 0.9 - 20;
        if (!insideBuilding(x, z)) return { x, z };
    }
    return { x: (h % 100) - 50, z: 30 };
}

// --- feed ingestion ----------------------------------------------------------

// --- profile backfill --------------------------------------------------------
// The world relay carries few kind-0 events, so NPC names/faces come from a
// dedicated profile relay. One socket, batched author queries, read-only.

const profileQueue = new Set();
let profileWs = null;
let profileRelayIdx = 0;

function requestProfile(pubkey) {
    if (profiles.has(pubkey)) return;
    profileQueue.add(pubkey);
}

function flushProfileQueue() {
    if (profileQueue.size === 0) return;
    const ask = (ws) => {
        const authors = [...profileQueue];
        profileQueue.clear();
        ws.send(JSON.stringify(['REQ', 'p' + Date.now(), { kinds: [0], authors }]));
    };
    if (profileWs && profileWs.readyState === WebSocket.OPEN) { ask(profileWs); return; }
    if (profileWs && profileWs.readyState === WebSocket.CONNECTING) return; // retry next flush
    const url = CONFIG.PROFILE_RELAYS[profileRelayIdx % CONFIG.PROFILE_RELAYS.length];
    profileWs = new WebSocket(url);
    const sock = profileWs;
    // a relay that hangs in CONNECTING blocks the rotation — cut it loose
    const guard = setTimeout(() => {
        if (sock.readyState === WebSocket.CONNECTING) sock.close();
    }, 6000);
    profileWs.onopen = () => { clearTimeout(guard); ask(profileWs); };
    profileWs.onmessage = (msg) => {
        try {
            const d = JSON.parse(msg.data);
            // absorb only — a late profile for a previous relay's author must
            // not resurrect that NPC after a relay jump
            if (d[0] === 'EVENT' && d[2].kind === 0) absorbProfile(d[2]);
        } catch { /* ignore */ }
    };
    profileWs.onclose = (e) => {
        // rotate to the next relay if this one never worked
        if (!e.wasClean) profileRelayIdx++;
        profileWs = null;
    };
    profileWs.onerror = () => { /* onclose follows and rotates */ };
}

/** console diagnostics for the profile backfill (no UI) */
export function profileDebug() {
    return { queued: profileQueue.size, relayIdx: profileRelayIdx, wsState: profileWs ? profileWs.readyState : null };
}

function upsertNpc(pubkey) {
    if (npcs.has(pubkey)) return npcs.get(pubkey);
    if (npcs.size >= CONFIG.NPC_LIMIT && !follows.has(pubkey)) return null;
    requestProfile(pubkey);
    const home = homeFor(pubkey);
    const npc = {
        pubkey,
        x: home.x, z: home.z, ry: 0,
        home,
        tx: home.x, tz: home.z, // wander target
        nextWander: 0,
        note: null,
    };
    npcs.set(pubkey, npc);
    emit('npc', npc);
    return npc;
}

export function nameOf(pubkey) {
    const p = profiles.get(pubkey);
    return (p && (p.display_name || p.name)) || Nostr.shortNpub(pubkey);
}

export function pictureOf(pubkey) {
    const p = profiles.get(pubkey);
    return (p && p.picture) || null;
}

function absorbProfile(ev) {
    try {
        const existing = profiles.get(ev.pubkey);
        if (!existing || existing._at < ev.created_at) {
            const p = JSON.parse(ev.content);
            p._at = ev.created_at;
            profiles.set(ev.pubkey, p);
        }
    } catch { /* bad profile json */ }
}

function handleEvent(subId, ev) {
    if (ev.kind === 0) {
        absorbProfile(ev);
        upsertNpc(ev.pubkey);
    } else if (ev.kind === 1) {
        const npc = upsertNpc(ev.pubkey);
        if (npc && (!npc.note || npc.note.created_at < ev.created_at)) {
            npc.note = { content: ev.content, created_at: ev.created_at };
        }
        feedNotes.push(ev);
        feedNotes.sort((a, b) => b.created_at - a.created_at);
        if (feedNotes.length > 100) feedNotes.length = 100;
        emit('note', ev);
    } else if (ev.kind === CONFIG.KIND_PRESENCE) {
        if (ev.pubkey === Nostr.identity.sessionPk) return;
        let d;
        try { d = JSON.parse(ev.content); } catch { return; }
        if (typeof d.x !== 'number' || typeof d.z !== 'number') return;
        let p = players.get(ev.pubkey);
        if (!p) {
            p = { pubkey: ev.pubkey, x: d.x, z: d.z, ry: d.ry || 0 };
            players.set(ev.pubkey, p);
        }
        p.tx = d.x; p.tz = d.z; p.try = d.ry || 0;
        p.name = d.name || 'Wanderer';
        p.picture = d.picture || null;
        p.mainPk = d.pk || null;
        p.lastSeen = Date.now();
    } else if (ev.kind === CONFIG.KIND_CHAT) {
        let d;
        try { d = JSON.parse(ev.content); } catch { return; }
        if (typeof d.text !== 'string' || !d.text.trim()) return;
        const fromSelf = ev.pubkey === Nostr.identity.sessionPk;
        if (fromSelf) return; // already echoed locally
        const msg = { name: String(d.name || 'Wanderer').slice(0, 30), text: d.text.slice(0, 200), ts: Date.now(), pubkey: ev.pubkey };
        chatLog.push(msg);
        if (chatLog.length > 80) chatLog.shift();
        emit('chat', msg);
    }
}

// --- presence publishing -----------------------------------------------------

let lastPub = 0;
let lastState = '';

function publishPresence(now) {
    const state = `${self.x.toFixed(1)},${self.z.toFixed(1)},${self.ry.toFixed(2)}`;
    const idle = state === lastState;
    const interval = idle ? CONFIG.PRESENCE_IDLE_MS : 1000 / CONFIG.PRESENCE_HZ;
    if (now - lastPub < interval) return;
    lastPub = now;
    lastState = state;
    Nostr.publish(CONFIG.KIND_PRESENCE, JSON.stringify({
        x: +self.x.toFixed(1), z: +self.z.toFixed(1), ry: +self.ry.toFixed(2),
        name: Nostr.identity.name,
        picture: Nostr.identity.picture || undefined,
        pk: Nostr.identity.mainPk || undefined,
    }));
}

export function sendChat(text) {
    text = text.trim().slice(0, 200);
    if (!text) return;
    Nostr.publish(CONFIG.KIND_CHAT, JSON.stringify({ text, name: Nostr.identity.name }));
    const msg = { name: Nostr.identity.name, text, ts: Date.now(), self: true, pubkey: Nostr.identity.sessionPk };
    chatLog.push(msg);
    emit('chat', msg);
}

// --- simulation --------------------------------------------------------------

let started = false;

export function start() {
    started = true;
    const since = Math.floor(Date.now() / 1000);
    Nostr.on('event', handleEvent);
    Nostr.subscribe([{ kinds: CONFIG.FEED_KINDS, limit: CONFIG.FEED_LIMIT }]);
    Nostr.subscribe([{ kinds: [CONFIG.KIND_PRESENCE, CONFIG.KIND_CHAT], '#t': [CONFIG.TAG], since }]);
    setInterval(flushProfileQueue, 2500);
}

/**
 * Jump the whole world onto a different relay: clear everything that came off
 * the old relay, then reconnect (live subscriptions replay automatically).
 */
export async function switchRelay(url) {
    npcs.clear();
    players.clear();
    feedNotes.length = 0;
    emit('reset');
    await Nostr.setRelay(url);
}

/**
 * Pull the logged-in user's contact list (kind 3) so their follows can be
 * highlighted in the world. One-shot socket against the profile relays —
 * contact lists rarely live on small world relays.
 */
export function fetchFollows(mainPk) {
    let idx = 0;
    const tryRelay = () => {
        if (idx >= CONFIG.PROFILE_RELAYS.length) return;
        const sock = new WebSocket(CONFIG.PROFILE_RELAYS[idx++]);
        let done = false;
        // onclose is the single retry path; everything else just closes
        const guard = setTimeout(() => sock.close(), 6000);
        sock.onopen = () => sock.send(JSON.stringify(['REQ', 'f1', { kinds: [3], authors: [mainPk], limit: 1 }]));
        sock.onmessage = (msg) => {
            try {
                const d = JSON.parse(msg.data);
                if (d[0] === 'EVENT' && d[2].kind === 3) {
                    for (const t of d[2].tags) if (t[0] === 'p' && t[1]) follows.add(t[1]);
                    done = true;
                }
                if (d[0] === 'EOSE') sock.close();
            } catch { /* ignore */ }
        };
        sock.onerror = () => { /* onclose follows */ };
        sock.onclose = () => { clearTimeout(guard); if (!done) tryRelay(); };
    };
    tryRelay();
}

export function tick(dt, now) {
    // local player integration happens in scene.js (input lives there);
    if (started) publishPresence(now);

    // NPC wandering
    for (const npc of npcs.values()) {
        if (now > npc.nextWander) {
            npc.nextWander = now + 4000 + Math.random() * 8000;
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 10;
            const tx = npc.home.x + Math.cos(a) * r;
            const tz = npc.home.z + Math.sin(a) * r;
            if (!insideBuilding(tx, tz)) { npc.tx = tx; npc.tz = tz; }
        }
        const dx = npc.tx - npc.x, dz = npc.tz - npc.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.3) {
            const sp = Math.min(1.6 * dt, dist);
            npc.x += dx / dist * sp;
            npc.z += dz / dist * sp;
            npc.ry = Math.atan2(dx, dz);
        }
    }

    // Remote player interpolation + expiry
    for (const [k, p] of players) {
        if (now - p.lastSeen > CONFIG.PRESENCE_TIMEOUT_MS) { players.delete(k); continue; }
        const lerp = Math.min(1, dt * 8);
        p.x += (p.tx - p.x) * lerp;
        p.z += (p.tz - p.z) * lerp;
        p.ry = p.try;
    }
}

export { insideBuilding };
