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

const events = { chat: [], npc: [], note: [] };
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

function upsertNpc(pubkey) {
    if (npcs.has(pubkey)) return npcs.get(pubkey);
    if (npcs.size >= CONFIG.NPC_LIMIT) return null;
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

function handleEvent(subId, ev) {
    if (ev.kind === 0) {
        try {
            const existing = profiles.get(ev.pubkey);
            if (!existing || existing._at < ev.created_at) {
                const p = JSON.parse(ev.content);
                p._at = ev.created_at;
                profiles.set(ev.pubkey, p);
            }
        } catch { /* bad profile json */ }
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
