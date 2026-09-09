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
    tank: false,  // mounted in a tank
    hp: CONFIG.MAX_HP,
};

export const npcs = new Map();     // pubkey -> npc
export const players = new Map();  // session pubkey -> remote player
export const profiles = new Map(); // pubkey -> kind0 profile
export const feedNotes = [];       // newest-first kind1 events (for the feed hall)
export const chatLog = [];         // {name, text, ts, self}
export const follows = new Set();  // pubkeys the logged-in user follows (kind 3)
export const houses = new Map();   // pubkey -> {x, z, yaw, pubkey}
export const parkedTanks = new Map(); // pubkey -> {x, z, ry, pubkey}
export const shells = new Map();   // id -> {x, z, ry, dist, owner}
let shellSerial = 0;

const events = { chat: [], npc: [], note: [], reset: [], house: [], park: [], unpark: [], fx: [] };
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

/** Rotate a local (lx, lz) offset by yaw — matches three.js rotation.y. */
function rotY(lx, lz, yaw) {
    return {
        x: lx * Math.cos(yaw) + lz * Math.sin(yaw),
        z: -lx * Math.sin(yaw) + lz * Math.cos(yaw),
    };
}

/** Circle-collision against house lots (houses are chunky — keep out). */
export function insideHouse(x, z, pad = 0) {
    for (const h of houses.values()) {
        if (Math.hypot(x - h.x, z - h.z) < 4.6 + pad) return h;
    }
    return null;
}

/**
 * Every npub gets a house: home yard pushed away from the town centre, door
 * facing back toward the plaza, garage on the right with their tank parked
 * out front.
 */
export function addHouse(pubkey, home) {
    if (houses.has(pubkey)) return houses.get(pubkey);
    if (!home) home = homeFor(pubkey);
    let dx = home.x, dz = home.z + 20; // outward from town centre (0, -20)
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    const yaw = Math.atan2(-dx, -dz); // face the plaza
    let hx = home.x + dx * 9, hz = home.z + dz * 9;
    // a lot that lands on a town building flips to the plaza side of the yard
    if (insideBuilding(hx, hz, 8)) { hx = home.x - dx * 9; hz = home.z - dz * 9; }
    if (insideBuilding(hx, hz, 8)) return null; // no buildable land — no house
    const house = { pubkey, x: hx, z: hz, yaw };
    houses.set(pubkey, house);
    emit('house', house);
    const spot = rotY(5.6, 3.4, yaw);
    const tank = { pubkey, x: house.x + spot.x, z: house.z + spot.z, ry: yaw };
    parkedTanks.set(pubkey, tank);
    emit('park', tank);
    return house;
}

function homeFor(pubkey) {
    const h = hash32(pubkey);
    // Suburban belts around the town centre: yards stay off the plaza (r<28)
    // and off the loop road band (~64-71 from centre once the lot is pushed
    // 9m outward), so streets and the park stay clear.
    for (let attempt = 0; attempt < 8; attempt++) {
        const hx = hash32(pubkey + ':' + attempt);
        let r = 36 + (h % 1000) / 1000 * 114;
        if (r > 50 && r < 80) r += 52;
        const a = (hx % 6283) / 1000;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r * 0.9 - 20;
        // the plaza + its ring road are centred on the origin, not (0,-20)
        if (!insideBuilding(x, z) && Math.hypot(x, z) > 32) return { x, z };
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
    addHouse(pubkey, home);
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
        p.tank = !!d.tank;
        p.name = d.name || 'Wanderer';
        p.picture = d.picture || null;
        p.mainPk = d.pk || null;
        p.lastSeen = Date.now();
    } else if (ev.kind === CONFIG.KIND_ACTION) {
        if (ev.pubkey === Nostr.identity.sessionPk) return;
        let d;
        try { d = JSON.parse(ev.content); } catch { return; }
        if (d.a === 'shot' && typeof d.x === 'number' && typeof d.z === 'number') {
            spawnShell(ev.pubkey, d.x, d.z, +d.ry || 0);
        } else if ((d.a === 'hit' || d.a === 'kill') && d.shooter === Nostr.identity.sessionPk) {
            emit('fx', { type: d.a === 'kill' ? 'killed' : 'landed', name: String(d.name || 'someone').slice(0, 30) });
            if (d.a === 'kill' && typeof d.x === 'number') emit('fx', { type: 'boom', x: d.x, z: d.z, big: true });
        } else if (d.a === 'kill' && typeof d.x === 'number') {
            // bystander view of someone else's kill
            emit('fx', { type: 'boom', x: d.x, z: d.z, big: true });
        }
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

// --- tank combat -------------------------------------------------------------

let lastFire = 0;

export function mountTank(parked) {
    if (self.tank || self.inside) return;
    parkedTanks.delete(parked.pubkey);
    emit('unpark', parked);
    self.tank = true;
    self.hp = CONFIG.MAX_HP;
    self.x = parked.x; self.z = parked.z; self.ry = parked.ry;
    emit('fx', { type: 'mount' });
}

export function dismountTank() {
    if (!self.tank) return;
    self.tank = false;
    // leave the tank parked right here, ready to remount
    const key = 'left:' + (++shellSerial);
    const tank = { pubkey: key, x: self.x, z: self.z, ry: self.ry };
    parkedTanks.set(key, tank);
    emit('park', tank);
    // step out beside it
    const side = rotY(2.6, 0, self.ry);
    self.x += side.x; self.z += side.z;
}

function spawnShell(owner, x, z, ry) {
    const id = owner.slice(0, 8) + ':' + (++shellSerial);
    shells.set(id, { x, z, ry, dist: 0, owner });
    return id;
}

export function fire() {
    if (!self.tank || self.inside) return;
    const now = Date.now();
    if (now - lastFire < CONFIG.FIRE_COOLDOWN_MS) return;
    lastFire = now;
    const muzzle = rotY(0, 2.6, self.ry);
    const x = +(self.x + muzzle.x).toFixed(1), z = +(self.z + muzzle.z).toFixed(1);
    spawnShell(Nostr.identity.sessionPk, x, z, self.ry);
    Nostr.publish(CONFIG.KIND_ACTION, JSON.stringify({ a: 'shot', x, z, ry: +self.ry.toFixed(2) }));
    emit('fx', { type: 'muzzle', x, z });
}

function respawn(killerName) {
    emit('fx', { type: 'boom', x: self.x, z: self.z, big: true });
    self.hp = CONFIG.MAX_HP;
    self.x = (Math.random() - 0.5) * 16;
    self.z = 12 + Math.random() * 8;
    emit('fx', { type: 'died', by: killerName });
}

function stepShells(dt) {
    const step = CONFIG.SHELL_SPEED * dt;
    for (const [id, sh] of shells) {
        sh.x += Math.sin(sh.ry) * step;
        sh.z += Math.cos(sh.ry) * step;
        sh.dist += step;
        if (sh.dist > CONFIG.SHELL_RANGE || insideBuilding(sh.x, sh.z, 0) || insideHouse(sh.x, sh.z)) {
            shells.delete(id);
            emit('fx', { type: 'boom', x: sh.x, z: sh.z });
            continue;
        }
        // victim-authoritative hit detection: only my own client decides I was
        // hit, then announces it so the shooter gets credit
        if (sh.owner !== Nostr.identity.sessionPk && !self.inside &&
            Math.hypot(sh.x - self.x, sh.z - self.z) < CONFIG.SHELL_HIT_RADIUS) {
            shells.delete(id);
            self.hp -= CONFIG.SHELL_DMG;
            emit('fx', { type: 'boom', x: sh.x, z: sh.z });
            const shooter = players.get(sh.owner);
            const dead = self.hp <= 0;
            Nostr.publish(CONFIG.KIND_ACTION, JSON.stringify({
                a: dead ? 'kill' : 'hit',
                shooter: sh.owner,
                name: Nostr.identity.name,
                x: +self.x.toFixed(1), z: +self.z.toFixed(1),
            }));
            if (dead) respawn(shooter ? shooter.name : 'someone');
            else emit('fx', { type: 'hurt' });
        }
    }
}

// --- presence publishing -----------------------------------------------------

let lastPub = 0;
let lastState = '';

function publishPresence(now) {
    const state = `${self.x.toFixed(1)},${self.z.toFixed(1)},${self.ry.toFixed(2)},${self.tank ? 1 : 0}`;
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
        tank: self.tank ? 1 : undefined,
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
    Nostr.subscribe([{ kinds: [CONFIG.KIND_PRESENCE, CONFIG.KIND_CHAT, CONFIG.KIND_ACTION], '#t': [CONFIG.TAG], since }]);
    setInterval(flushProfileQueue, 2500);
}

/**
 * Jump the whole world onto a different relay: clear everything that came off
 * the old relay, then reconnect (live subscriptions replay automatically).
 */
export async function switchRelay(url) {
    npcs.clear();
    players.clear();
    houses.clear();
    parkedTanks.clear();
    shells.clear();
    feedNotes.length = 0;
    if (self.tank) { self.tank = false; self.hp = CONFIG.MAX_HP; }
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
    stepShells(dt);

    // NPC wandering
    for (const npc of npcs.values()) {
        if (now > npc.nextWander) {
            npc.nextWander = now + 4000 + Math.random() * 8000;
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 10;
            const tx = npc.home.x + Math.cos(a) * r;
            const tz = npc.home.z + Math.sin(a) * r;
            if (!insideBuilding(tx, tz) && !insideHouse(tx, tz)) { npc.tx = tx; npc.tz = tz; }
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
