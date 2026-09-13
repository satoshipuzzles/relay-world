/**
 * world.js - game state: the local player, feed NPCs, remote players, chat.
 *
 * NPCs are real npubs pulled off the Cool Feeds relay. Each author gets a
 * deterministic home spot (hashed from their pubkey) and wanders around it,
 * carrying their latest note as a speech bubble.
 */
import { CONFIG, BUILDINGS, WEAPONS } from './config.js';
import * as Nostr from './nostr.js';

export const self = {
    x: 0, z: 12, ry: Math.PI, // facing the buildings
    vx: 0, vz: 0,
    moving: false,
    inside: null, // building id when indoors
    tank: false,  // mounted in a tank
    dead: false,  // between being killed and respawning
    hp: CONFIG.MAX_HP,
    weapon: null, // WEAPONS key while armed on foot
    ammo: 0,
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
export const bullets = new Map();  // id -> {x, z, ry, dist, owner, w}
export const pickups = new Map();  // id -> {id, x, z, w, takenUntil}
export const score = new Map();    // session pubkey -> {name, kills, deaths}
export const round = { height: 0, since: 0 }; // current Bitcoin block = current round
let shellSerial = 0;

const events = { chat: [], npc: [], note: [], reset: [], house: [], park: [], unpark: [], fx: [], pickup: [], round: [], score: [], feed: [] };
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

const boxHit = (b, x, z, pad) =>
    x > b.x - b.w / 2 - pad && x < b.x + b.w / 2 + pad &&
    z > b.z - b.d / 2 - pad && z < b.z + b.d / 2 + pad;

function insideBuilding(x, z, pad = 4) {
    return BUILDINGS.find(b => boxHit(b, x, z, pad)) ||
        cityBlocks.find(b => boxHit(b, x, z, pad));
}

// --- downtown ------------------------------------------------------------------
// A deterministic tower grid north of the loop road. Purely a function of the
// hash, so every client agrees on the skyline — and therefore on collisions,
// bullet stops and weapon-pickup placement.

export const cityBlocks = []; // {x, z, w, d, h, color}
function buildCity() {
    const palette = [0x54606e, 0x6e6258, 0x4e5a52, 0x605668, 0x5a6472, 0x685e50];
    for (let gx = 0; gx < 6; gx++) {
        for (let gz = 0; gz < 2; gz++) {
            const bx = -80 + gx * 32, bz = 66 + gz * 32;
            const h = hash32(`city:${gx}:${gz}`);
            if (h % 7 === 0) continue; // a few empty lots keep sight lines open
            const mk = (x, z, w, d, i) => {
                const hh = hash32(`twr:${gx}:${gz}:${i}`);
                cityBlocks.push({ x, z, w, d, h: 18 + (hh % 26), color: palette[hh % palette.length] });
            };
            if (h % 3 === 0) { mk(bx - 6, bz, 10, 20, 0); mk(bx + 6, bz, 10, 16, 1); }
            else mk(bx, bz, 18, 18, 0);
        }
    }
}
buildCity();

// --- traffic ---------------------------------------------------------------
// Ambient cars on fixed routes. Local-only and deterministic enough to feel
// shared; the only gameplay effect (getting run over) is victim-authoritative
// like every other death, so kills still sync through the relay.

export const cars = []; // {x, z, ry, path, s, speed, color, lastHit}

function circlePath(cx, cz, r, dir) {
    return (s) => {
        const a = s / r * dir;
        return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, dx: -Math.sin(a) * dir, dz: Math.cos(a) * dir };
    };
}

function rectPath(x0, z0, x1, z1) {
    const w = x1 - x0, d = z1 - z0, P = 2 * (w + d);
    return (s) => {
        s = ((s % P) + P) % P;
        if (s < w) return { x: x0 + s, z: z0, dx: 1, dz: 0 };
        s -= w;
        if (s < d) return { x: x1, z: z0 + s, dx: 0, dz: 1 };
        s -= d;
        if (s < w) return { x: x1 - s, z: z1, dx: -1, dz: 0 };
        s -= w;
        return { x: x0, z: z1 - s, dx: 0, dz: -1 };
    };
}

function buildTraffic() {
    const colors = [0xc23b22, 0x2b6cb0, 0xe8b23a, 0x3f8f5f, 0x8a4fbf, 0xd8d8d8, 0x23262c];
    const routes = [
        { path: circlePath(0, 0, 18.5, 1), len: 116, n: 3, speed: 8 },     // plaza ring
        { path: circlePath(0, -20, 67.5, -1), len: 424, n: 5, speed: 12 }, // suburb loop
        { path: rectPath(-64, 50, 64, 114), len: 512, n: 4, speed: 11 },   // downtown outer
        { path: rectPath(-32, 50, 32, 82), len: 192, n: 2, speed: 10 },    // downtown inner
    ];
    let ci = 0;
    for (const r of routes) {
        for (let i = 0; i < r.n; i++) {
            cars.push({
                path: r.path, s: (r.len / r.n) * i,
                speed: r.speed * (0.88 + (ci % 3) * 0.12),
                color: colors[ci++ % colors.length],
                x: 0, z: 0, ry: 0, lastHit: 0,
            });
        }
    }
}
buildTraffic();

function stepTraffic(dt, now) {
    for (const c of cars) {
        c.s += c.speed * dt;
        const p = c.path(c.s);
        c.x = p.x; c.z = p.z;
        c.ry = Math.atan2(p.dx, p.dz);
        if (!started || self.dead || self.inside || self.tank) continue;
        if (now - c.lastHit < CONFIG.CAR_HIT_COOLDOWN_MS) continue;
        if (Math.hypot(c.x - self.x, c.z - self.z) < CONFIG.CAR_HIT_RADIUS) {
            c.lastHit = now;
            // shoved clear (GTA rules: traffic does not brake), then hurt
            const px = self.x - c.x, pz = self.z - c.z;
            const pl = Math.hypot(px, pz) || 1;
            const nx = self.x + px / pl * 3.5, nz = self.z + pz / pl * 3.5;
            if (!insideBuilding(nx, nz, 1) && !insideHouse(nx, nz)) { self.x = nx; self.z = nz; }
            damageSelf('traffic', 'car', CONFIG.CAR_DMG, c.x, c.z);
        }
    }
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
        // keep yards out of downtown — that land belongs to the towers
        if (x > -102 && x < 102 && z > 40 && z < 122) continue;
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
        p.w = WEAPONS[d.w] ? d.w : null;
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
        } else if (d.a === 'gun' && WEAPONS[d.w] && typeof d.x === 'number' && typeof d.z === 'number' && Array.isArray(d.rys)) {
            for (const ry of d.rys.slice(0, 8)) spawnBullet(ev.pubkey, d.w, d.x, d.z, +ry || 0);
            emit('fx', { type: 'muzzle', x: d.x, z: d.z });
        } else if (d.a === 'hit' || d.a === 'kill') {
            // every client tallies every kill it hears exactly once: victims
            // tally their own at publish time, everyone else tallies here
            if (d.a === 'kill' && typeof d.shooter === 'string') {
                tallyKill(d.shooter, d.sName, ev.pubkey, d.name, d.w);
            }
            if (d.shooter === Nostr.identity.sessionPk) {
                emit('fx', { type: d.a === 'kill' ? 'killed' : 'landed', name: String(d.name || 'someone').slice(0, 30) });
            }
            if (typeof d.x === 'number' && typeof d.z === 'number') {
                emit('fx', { type: 'blood', x: d.x, z: d.z, heavy: d.a === 'kill' });
                if (d.a === 'kill') {
                    // the victim's live avatar hides while their corpse lies there
                    const p = players.get(ev.pubkey);
                    if (p) p.deadUntil = Date.now() + CONFIG.DEATH_MS;
                    emit('fx', { type: 'death', x: d.x, z: d.z, pubkey: ev.pubkey });
                    emit('fx', { type: 'boom', x: d.x, z: d.z, big: true });
                }
            }
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
    if (self.tank || self.inside || self.dead) return;
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
    if (self.inside || self.dead) return;
    if (!self.tank) { fireGun(); return; }
    const now = Date.now();
    if (now - lastFire < CONFIG.FIRE_COOLDOWN_MS) return;
    lastFire = now;
    const muzzle = rotY(0, 2.6, self.ry);
    const x = +(self.x + muzzle.x).toFixed(1), z = +(self.z + muzzle.z).toFixed(1);
    spawnShell(Nostr.identity.sessionPk, x, z, self.ry);
    Nostr.publish(CONFIG.KIND_ACTION, JSON.stringify({ a: 'shot', x, z, ry: +self.ry.toFixed(2) }));
    emit('fx', { type: 'muzzle', x, z });
}

/** Dying takes a moment: your body falls where you stood, the WASTED card
 *  shows who got you, then you come back at the plaza. */
function beginDeath(killerName) {
    self.dead = true;
    self.hp = 0;
    self.tank = false; // a killed tank is gone, not parked
    self.weapon = null; // guns drop on death — go find another
    self.ammo = 0;
    emit('fx', { type: 'boom', x: self.x, z: self.z, big: true });
    emit('fx', { type: 'blood', x: self.x, z: self.z, heavy: true });
    emit('fx', { type: 'death', x: self.x, z: self.z, pubkey: Nostr.identity.sessionPk });
    emit('fx', { type: 'selfdeath', by: killerName });
    setTimeout(() => {
        self.hp = CONFIG.MAX_HP;
        // centre of the plaza — inside the ring road, so respawning can't
        // drop you under the wheels of the plaza traffic
        self.x = (Math.random() - 0.5) * 12;
        self.z = 1 + Math.random() * 9;
        self.dead = false;
        emit('fx', { type: 'respawned' });
    }, CONFIG.DEATH_MS);
}

// --- Grand Theft Relay: on-foot gunplay ---------------------------------------

let lastGunFire = 0;

/**
 * Weapons lying around the map. Placement is pure function of the seed, so
 * every client lays out the identical arsenal with zero netcode; reseeding
 * (each Bitcoin block) reshuffles the whole map at once.
 */
export function placePickups(seed) {
    pickups.clear();
    const kinds = Object.keys(WEAPONS);
    for (let i = 0; i < CONFIG.PICKUPS_PER_ROUND; i++) {
        const h1 = hash32('gtr:' + seed + ':' + i);
        let x = 0, z = 12;
        for (let att = 0; att < 12; att++) {
            const hh = hash32('spot:' + seed + ':' + i + ':' + att);
            const a = (hh % 6283) / 1000;
            // half the guns fight over the plaza, half reward roaming the burbs
            const r = (i % 2 === 0) ? 7 + (hh >>> 16) % 32 : 30 + (hh >>> 16) % 75;
            const cx = Math.cos(a) * r, cz = Math.sin(a) * r * 0.9 - (i % 2 === 0 ? 0 : 20);
            if (!insideBuilding(cx, cz, 2) && !insideHouse(cx, cz, 0.6)) { x = cx; z = cz; break; }
        }
        const w = kinds[h1 % kinds.length];
        pickups.set('p' + seed + ':' + i, { id: 'p' + seed + ':' + i, x: +x.toFixed(1), z: +z.toFixed(1), w, takenUntil: 0 });
    }
    emit('pickup');
}

function spawnBullet(owner, w, x, z, ry) {
    bullets.set(owner.slice(0, 8) + ':b' + (++shellSerial), { x, z, ry, dist: 0, owner, w });
}

export function fireGun() {
    if (self.tank || self.inside || !self.weapon) return;
    const W = WEAPONS[self.weapon];
    const now = Date.now();
    if (now - lastGunFire < W.cooldown) return;
    if (self.ammo <= 0) return;
    lastGunFire = now;
    self.ammo--;
    const rys = [];
    for (let i = 0; i < W.pellets; i++) {
        rys.push(+(self.ry + (Math.random() - 0.5) * 2 * W.spread).toFixed(3));
    }
    const x = +(self.x + Math.sin(self.ry) * 1.0).toFixed(1);
    const z = +(self.z + Math.cos(self.ry) * 1.0).toFixed(1);
    for (const ry of rys) spawnBullet(Nostr.identity.sessionPk, self.weapon, x, z, ry);
    Nostr.publish(CONFIG.KIND_ACTION, JSON.stringify({ a: 'gun', w: self.weapon, x, z, rys }));
    emit('fx', { type: 'muzzle', x, z, small: true });
    if (self.ammo <= 0) { self.weapon = null; emit('fx', { type: 'dry' }); }
}

/** Victim-authoritative, same contract as tank shells: only my client decides
 *  I was hit, then announces it so the shooter gets credit. */
function damageSelf(owner, w, dmg, x, z) {
    if (self.dead) return; // corpses don't take more damage
    self.hp -= dmg;
    const shooter = players.get(owner);
    const sName = owner === 'traffic' ? 'TRAFFIC' : (shooter ? shooter.name : undefined);
    const dead = self.hp <= 0;
    Nostr.publish(CONFIG.KIND_ACTION, JSON.stringify({
        a: dead ? 'kill' : 'hit',
        shooter: owner,
        name: Nostr.identity.name,
        sName,
        w,
        x: +self.x.toFixed(1), z: +self.z.toFixed(1),
    }));
    if (dead) {
        tallyKill(owner, sName || null, Nostr.identity.sessionPk, Nostr.identity.name, w);
        beginDeath(sName || 'someone');
    } else {
        emit('fx', { type: 'blood', x: self.x, z: self.z });
        emit('fx', { type: 'hurt' });
    }
}

function stepBullets(dt) {
    const myRadius = self.tank ? CONFIG.SHELL_HIT_RADIUS : CONFIG.BULLET_HIT_RADIUS;
    for (const [id, b] of bullets) {
        const W = WEAPONS[b.w];
        const step = W.speed * dt;
        b.x += Math.sin(b.ry) * step;
        b.z += Math.cos(b.ry) * step;
        b.dist += step;
        const expired = b.dist > W.range || insideBuilding(b.x, b.z, 0) || insideHouse(b.x, b.z);
        const mine = b.owner === Nostr.identity.sessionPk;
        if (expired) {
            bullets.delete(id);
            emit('fx', { type: 'boom', x: b.x, z: b.z, big: !!W.blast });
            // rockets that die on a wall still shred anyone standing nearby
            if (W.blast && !mine && !self.inside &&
                Math.hypot(b.x - self.x, b.z - self.z) < W.blast) {
                damageSelf(b.owner, b.w, W.dmg, b.x, b.z);
            }
            continue;
        }
        if (!mine && !self.inside && Math.hypot(b.x - self.x, b.z - self.z) < myRadius) {
            bullets.delete(id);
            emit('fx', { type: 'boom', x: b.x, z: b.z, big: !!W.blast });
            damageSelf(b.owner, b.w, W.dmg, b.x, b.z);
        }
    }
}

/** One kill = one scoreboard line on every client that heard it. */
function tallyKill(shooterPk, shooterName, victimPk, victimName, w) {
    const s = score.get(shooterPk) || { name: '', kills: 0, deaths: 0 };
    s.kills++;
    if (shooterName) s.name = String(shooterName).slice(0, 30);
    score.set(shooterPk, s);
    const v = score.get(victimPk) || { name: '', kills: 0, deaths: 0 };
    v.deaths++;
    if (victimName) v.name = String(victimName).slice(0, 30);
    score.set(victimPk, v);
    emit('score');
    emit('feed', {
        shooter: String(shooterName || 'someone').slice(0, 24),
        victim: String(victimName || 'someone').slice(0, 24),
        w,
    });
}

// --- rounds: one Bitcoin block each ------------------------------------------

function newRound(height) {
    const first = !round.height;
    if (!first && height !== round.height) {
        let winner = null;
        for (const [pk, s] of score) {
            if (s.kills > 0 && (!winner || s.kills > winner.kills)) winner = { ...s, pk };
        }
        emit('round', { height, winner });
    }
    round.height = height;
    round.since = Date.now();
    score.clear();
    placePickups(height);
    emit('score');
}

// Primary clock: mempool.guide's websocket (CORS-exempt, pushes new blocks
// the moment they're mined, so rounds end live). Fallback: REST polling.
let blockWs = null;
let blockWsAlive = false;

function connectBlockWs() {
    let sock;
    try { sock = new WebSocket(CONFIG.BLOCK_WS); } catch { return; }
    blockWs = sock;
    const guard = setTimeout(() => {
        if (sock.readyState === WebSocket.CONNECTING) sock.close();
    }, 8000);
    sock.onopen = () => {
        clearTimeout(guard);
        sock.send(JSON.stringify({ action: 'want', data: ['blocks'] }));
    };
    sock.onmessage = (msg) => {
        let m;
        try { m = JSON.parse(msg.data); } catch { return; }
        let h = null;
        if (Array.isArray(m.blocks) && m.blocks.length) h = m.blocks[m.blocks.length - 1].height;
        if (m.block && typeof m.block.height === 'number') h = m.block.height;
        if (typeof h === 'number' && h > 0) {
            blockWsAlive = true;
            if (h !== round.height) newRound(h);
        }
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => {
        clearTimeout(guard);
        blockWsAlive = false;
        blockWs = null;
        setTimeout(connectBlockWs, 15000 + Math.random() * 10000);
    };
}

async function pollBlockFallback() {
    if (blockWsAlive) return; // the live feed owns the clock
    try {
        const res = await fetch(CONFIG.BLOCK_API_FALLBACK, { signal: AbortSignal.timeout(7000) });
        const h = parseInt(await res.text(), 10);
        if (Number.isFinite(h) && h > 0 && h !== round.height && !blockWsAlive) newRound(h);
    } catch { /* next tick */ }
}

/** console/test handle — lets a verify script end a round without waiting
 *  ~10 minutes for a real block. Not wired to any UI. */
export function forceRound(height) { newRound(height); }

function collectPickups(now) {
    if (self.inside || self.tank || self.dead) return;
    for (const p of pickups.values()) {
        if (p.takenUntil > now) continue;
        if (Math.hypot(p.x - self.x, p.z - self.z) < CONFIG.PICKUP_RADIUS) {
            p.takenUntil = now + CONFIG.PICKUP_RESPAWN_MS;
            self.weapon = p.w;
            self.ammo = WEAPONS[p.w].ammo;
            emit('pickup');
            emit('fx', { type: 'armed', w: p.w });
        }
    }
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
            emit('fx', { type: 'boom', x: sh.x, z: sh.z });
            damageSelf(sh.owner, 'tank', CONFIG.SHELL_DMG, sh.x, sh.z);
        }
    }
}

// --- presence publishing -----------------------------------------------------

let lastPub = 0;
let lastState = '';

function publishPresence(now) {
    const state = `${self.x.toFixed(1)},${self.z.toFixed(1)},${self.ry.toFixed(2)},${self.tank ? 1 : 0},${self.weapon || ''}`;
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
        w: self.weapon || undefined,
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
    placePickups(0); // reseeded as soon as the block poller learns the tip
    const since = Math.floor(Date.now() / 1000);
    Nostr.on('event', handleEvent);
    Nostr.subscribe([{ kinds: CONFIG.FEED_KINDS, limit: CONFIG.FEED_LIMIT }]);
    Nostr.subscribe([{ kinds: [CONFIG.KIND_PRESENCE, CONFIG.KIND_CHAT, CONFIG.KIND_ACTION], '#t': [CONFIG.TAG], since }]);
    setInterval(flushProfileQueue, 2500);
    connectBlockWs();
    setTimeout(pollBlockFallback, 6000); // cover a dead ws at boot
    setInterval(pollBlockFallback, CONFIG.BLOCK_POLL_MS);
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
    bullets.clear();
    score.clear(); // new relay, new opponents — the round's slate wipes
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
    stepBullets(dt);
    stepTraffic(dt, now);
    collectPickups(now);

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
