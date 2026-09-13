/**
 * ui.js - HUD, projected labels, chat, profile popup, arcade overlay, map.
 */
import { CONFIG, BUILDINGS, RELAYS, WEAPONS } from './config.js';
import * as World from './world.js';
import * as Scene from './scene.js';
import * as Nostr from './nostr.js';

const $ = (id) => document.getElementById(id);
const labelLayer = () => $('label-layer');
const labelPool = new Map(); // key -> div
let currentTarget = null;
let mapOpen = false;

export function toast(text, type = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = text;
    $('toast-container').appendChild(t);
    setTimeout(() => t.classList.add('fade'), 2600);
    setTimeout(() => t.remove(), 3200);
}

// --- labels & speech bubbles -------------------------------------------------

function labelFor(key, cls) {
    let el = labelPool.get(key);
    if (!el) {
        el = document.createElement('div');
        el.className = cls;
        labelLayer().appendChild(el);
        labelPool.set(key, el);
    }
    el.dataset.used = '1';
    return el;
}

function place(el, sx, sy, clampMargin = 0) {
    const w = window.innerWidth, h = window.innerHeight;
    // fully off-screen: hide rather than pinning to an edge
    if (sx < -150 || sx > w + 150 || sy < -120 || sy > h + 150) {
        el.style.display = 'none';
        return;
    }
    // near an edge: nudge inward so bubbles stop clipping on phones
    if (clampMargin) {
        sx = Math.max(clampMargin, Math.min(w - clampMargin, sx));
        sy = Math.max(48, Math.min(h - 10, sy));
    }
    el.style.transform = `translate(-50%, -100%) translate(${sx}px, ${sy}px)`;
    el.style.display = 'block';
}

/** Quick fade to black around a teleport so entering buildings feels like a
 *  scene change instead of a camera snap. */
function fadeThrough(cb) {
    const veil = $('fade-veil');
    veil.classList.add('on');
    setTimeout(() => {
        cb();
        veil.classList.remove('on');
    }, 240);
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

/** Fill a name label with an optional avatar image + text, via DOM nodes
 *  (never innerHTML — profile picture URLs are attacker-controlled). */
function fillNameLabel(el, picture, name) {
    const key = (picture || '') + '|' + name;
    if (el.dataset.content === key) return;
    el.dataset.content = key;
    el.textContent = '';
    if (picture) {
        const img = document.createElement('img');
        img.src = picture;
        img.onerror = () => img.remove();
        el.appendChild(img);
    }
    el.appendChild(document.createTextNode(name));
}

function updateLabels() {
    const s = World.self;
    for (const el of labelPool.values()) el.dataset.used = '';

    if (!s.inside) {
        for (const b of BUILDINGS) {
            const p = Scene.toScreen(b.x, b.h + 3.5, b.z);
            if (p) {
                const el = labelFor('sign:' + b.id, 'sign-label');
                el.textContent = b.sign;
                place(el, p.x, p.y);
            }
        }
        for (const npc of World.npcs.values()) {
            const d = Math.hypot(npc.x - s.x, npc.z - s.z);
            if (d < CONFIG.LABEL_RANGE) {
                const p = Scene.toScreen(npc.x, 2.9, npc.z);
                if (p) {
                    const el = labelFor('name:' + npc.pubkey, 'name-label npc');
                    const followed = World.follows.has(npc.pubkey);
                    el.classList.toggle('follow', followed);
                    fillNameLabel(el, World.pictureOf(npc.pubkey),
                        (followed ? '★ ' : '') + World.nameOf(npc.pubkey).slice(0, 20));
                    place(el, p.x, p.y, 60);
                }
            }
            if (npc.note && d < CONFIG.BUBBLE_RANGE) {
                const p = Scene.toScreen(npc.x, 3.7, npc.z);
                if (p) {
                    const el = labelFor('bubble:' + npc.pubkey, 'speech-bubble');
                    el.textContent = npc.note.content.slice(0, 90) + (npc.note.content.length > 90 ? '…' : '');
                    place(el, p.x, p.y, 100);
                }
            }
        }
        const now = Date.now();
        for (const p of World.pickups.values()) {
            if (p.takenUntil > now) continue;
            if (Math.hypot(p.x - s.x, p.z - s.z) < 24) {
                const sp = Scene.toScreen(p.x, 2.1, p.z);
                if (sp) {
                    const el = labelFor('pickup:' + p.id, 'pickup-label');
                    const W = WEAPONS[p.w];
                    el.textContent = `${W.icon} ${W.name}`;
                    place(el, sp.x, sp.y);
                }
            }
        }
        for (const pl of World.players.values()) {
            const d = Math.hypot(pl.x - s.x, pl.z - s.z);
            if (d < CONFIG.LABEL_RANGE * 2) {
                const p = Scene.toScreen(pl.x, 3.1, pl.z);
                if (p) {
                    const el = labelFor('pname:' + pl.pubkey, 'name-label player');
                    fillNameLabel(el, pl.picture, (pl.name || 'Wanderer').slice(0, 20));
                    place(el, p.x, p.y, 60);
                }
            }
        }
    }

    for (const [key, el] of labelPool) {
        if (!el.dataset.used) {
            el.remove();
            labelPool.delete(key);
        }
    }
}

// --- interact prompt ---------------------------------------------------------

function updateInteract() {
    currentTarget = Scene.nearestInteractable();
    const prompt = $('interact-prompt');
    const btn = $('action-button');
    if (currentTarget) {
        prompt.textContent = currentTarget.type === 'dismount'
            ? '[SPACE] FIRE · [E] EXIT TANK'
            : `[E] ${currentTarget.label}`;
        prompt.classList.remove('hide');
        btn.classList.remove('hide');
    } else {
        prompt.classList.add('hide');
        btn.classList.add('hide');
    }
    const inTank = World.self.tank && !World.self.inside;
    const armed = !World.self.tank && !World.self.inside && !!World.self.weapon;
    $('fire-button').classList.toggle('hide', !inTank && !armed);
    const wPill = $('weapon-pill');
    if (armed) {
        const W = WEAPONS[World.self.weapon];
        wPill.textContent = `${W.icon} ${W.name} ${World.self.ammo}`;
        wPill.classList.remove('hide');
    } else wPill.classList.add('hide');
    const hpPill = $('hp-pill');
    hpPill.classList.toggle('hide', !inTank && !armed && World.self.hp >= CONFIG.MAX_HP);
    hpPill.textContent = '❤ ' + Math.max(0, World.self.hp);
}

export function doInteract() {
    if (!currentTarget || World.self.dead) return;
    const { type, data } = currentTarget;
    if (type === 'door') {
        fadeThrough(() => {
            Scene.enterBuilding(data);
            toast(`Entered ${data.name}`);
            if (data.id === 'feed-hall') openFeedPanel();
        });
    } else if (type === 'exit') {
        fadeThrough(() => {
            Scene.exitBuilding();
            closeFeedPanel();
        });
    } else if (type === 'cabinet') {
        openArcade(data.game);
    } else if (type === 'npc') {
        openProfile(data.pubkey, data.note);
    } else if (type === 'tank') {
        World.mountTank(data);
        toast('Tank mounted — SPACE or 🔥 fires, E climbs out', 'success');
    } else if (type === 'dismount') {
        World.dismountTank();
        toast('Left the tank — it stays parked here');
    } else if (type === 'house') {
        const npc = World.npcs.get(data.pubkey);
        openProfile(data.pubkey, npc ? npc.note : null);
    } else if (type === 'player') {
        if (data.mainPk) openProfile(data.mainPk, null);
        else toast(`${data.name} is exploring as a guest`);
    }
}

// --- profile popup -----------------------------------------------------------

export function openProfile(pubkey, note) {
    const p = World.profiles.get(pubkey) || {};
    $('profile-name').textContent = World.nameOf(pubkey);
    $('profile-npub').textContent = Nostr.shortNpub(pubkey);
    $('profile-about').textContent = (p.about || '').slice(0, 240);
    const pic = $('profile-pic');
    pic.src = p.picture || '';
    pic.style.display = p.picture ? 'block' : 'none';
    const noteEl = $('profile-note');
    if (note) {
        noteEl.textContent = note.content.slice(0, 400);
        noteEl.classList.remove('hide');
    } else noteEl.classList.add('hide');
    const zap = $('profile-zap');
    const lud = p.lud16 || p.lud06;
    if (p.lud16 && p.lud16.includes('@')) {
        zap.href = 'lightning:' + p.lud16;
        zap.classList.remove('hide');
    } else if (lud) {
        zap.href = 'lightning:' + lud;
        zap.classList.remove('hide');
    } else zap.classList.add('hide');
    $('profile-njump').href = 'https://njump.me/' + Nostr.npub(pubkey);
    $('profile-popup').classList.remove('hide');
}

// --- arcade ------------------------------------------------------------------

export function openArcade(game) {
    $('arcade-title').textContent = game.title;
    $('arcade-iframe').src = game.url;
    $('arcade-overlay').classList.remove('hide');
}

export function closeArcade() {
    $('arcade-iframe').src = 'about:blank';
    $('arcade-overlay').classList.add('hide');
}

// --- feed hall panel ---------------------------------------------------------

let feedPanel = null;

function renderFeedPanel() {
    if (!feedPanel) return;
    const rows = World.feedNotes.slice(0, 25).map(ev => {
        const age = Math.max(0, Math.floor((Date.now() / 1000 - ev.created_at) / 60));
        const when = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`;
        return `<div class="feed-row"><span class="feed-author">${esc(World.nameOf(ev.pubkey).slice(0, 18))}</span><span class="feed-age">${when}</span><div class="feed-text">${esc(ev.content.slice(0, 200))}</div></div>`;
    }).join('');
    const host = esc(Nostr.currentRelay().replace('wss://', '').toUpperCase());
    feedPanel.innerHTML = `<h3>⚡ LIVE ON ${host}</h3>${rows || '<div class="feed-row">Listening for notes…</div>'}`;
}

function openFeedPanel() {
    if (feedPanel) return;
    feedPanel = document.createElement('div');
    feedPanel.id = 'feed-panel';
    document.body.appendChild(feedPanel);
    renderFeedPanel();
}

function closeFeedPanel() {
    if (feedPanel) { feedPanel.remove(); feedPanel = null; }
}

// --- relay picker ------------------------------------------------------------

let jumping = false;

function renderRelayList() {
    const list = $('relay-list');
    list.textContent = '';
    for (const r of RELAYS) {
        const row = document.createElement('button');
        row.className = 'relay-row' + (r.url === Nostr.currentRelay() ? ' active' : '');
        const name = document.createElement('span');
        name.textContent = (r.url === Nostr.currentRelay() ? '▶ ' : '') + r.name;
        const url = document.createElement('span');
        url.className = 'relay-url';
        url.textContent = r.url.replace('wss://', '');
        row.append(name, url);
        row.addEventListener('click', () => jumpRelay(r));
        list.appendChild(row);
    }
}

async function jumpRelay(r) {
    if (jumping || r.url === Nostr.currentRelay()) return;
    jumping = true;
    $('relay-panel').classList.add('hide');
    toast(`Jumping to ${r.name}…`);
    try {
        await World.switchRelay(r.url);
        $('relay-pill').textContent = '⚡ ' + r.url.replace('wss://', '');
        toast(`Welcome to ${r.name} — new relay, new npubs`, 'success');
    } catch {
        toast(`${r.name} unreachable — retrying in background`, 'error');
        $('relay-pill').textContent = '⚡ ' + r.url.replace('wss://', '');
    }
    jumping = false;
}

function toggleRelayPanel(force) {
    const panel = $('relay-panel');
    const show = force !== undefined ? force : panel.classList.contains('hide');
    if (show) renderRelayList();
    panel.classList.toggle('hide', !show);
}

// --- chat --------------------------------------------------------------------

function addChatRow(msg) {
    const log = $('chat-log');
    const row = document.createElement('div');
    row.className = 'chat-row' + (msg.self ? ' self' : '');
    row.innerHTML = `<span class="chat-name">${esc(msg.name)}:</span> ${esc(msg.text)}`;
    log.appendChild(row);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
}

function openChatInput() {
    $('chat-input-row').classList.remove('hide');
    $('chat-input').focus();
}

function closeChatInput() {
    $('chat-input-row').classList.add('hide');
    $('chat-input').blur();
}

// --- Grand Theft Relay: scoreboard, kill feed, round splash --------------------

function renderScore() {
    const body = $('score-rows');
    body.textContent = '';
    const rows = [...World.score.entries()].map(([pk, s]) => ({ pk, ...s }));
    if (!rows.some(r => r.pk === Nostr.identity.sessionPk)) {
        rows.push({ pk: Nostr.identity.sessionPk, name: Nostr.identity.name, kills: 0, deaths: 0 });
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    rows.slice(0, 12).forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'score-row' + (r.pk === Nostr.identity.sessionPk ? ' me' : '');
        const rank = document.createElement('span');
        rank.textContent = i === 0 && r.kills > 0 ? '👑' : String(i + 1);
        const name = document.createElement('span');
        name.className = 'score-name';
        name.textContent = (r.name || 'Wanderer').slice(0, 22);
        const kd = document.createElement('span');
        kd.textContent = r.kills + ' / ' + r.deaths;
        div.append(rank, name, kd);
        body.appendChild(div);
    });
    $('score-block').textContent = World.round.height
        ? `ROUND · BLOCK ${World.round.height}` : 'ROUND · WAITING FOR CHAIN…';
}

function toggleScore(force) {
    const el = $('score-overlay');
    const show = force !== undefined ? force : el.classList.contains('hide');
    if (show) renderScore();
    el.classList.toggle('hide', !show);
}

function addKillFeedRow(f) {
    const feed = $('kill-feed');
    const row = document.createElement('div');
    row.className = 'kill-row';
    const icon = f.w === 'tank' ? '💥' : (WEAPONS[f.w] ? WEAPONS[f.w].icon : '🔫');
    row.textContent = `${f.shooter} ${icon} ${f.victim}`;
    feed.appendChild(row);
    while (feed.children.length > 5) feed.firstChild.remove();
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 600); }, 6000);
}

function showRoundSplash({ height, winner }) {
    const sp = $('round-splash');
    $('splash-block').textContent = `⛏ BLOCK ${height} MINED`;
    $('splash-winner').textContent = winner
        ? `👑 ${winner.name || 'a wanderer'} WINS — ${winner.kills} KILL${winner.kills === 1 ? '' : 'S'}`
        : 'NO KILLS THIS ROUND';
    $('splash-sub').textContent = 'scores reset · weapons reshuffled';
    sp.classList.remove('hide');
    clearTimeout(sp._t);
    sp._t = setTimeout(() => sp.classList.add('hide'), 5200);
}

// --- map ---------------------------------------------------------------------

function drawMap() {
    const canvas = $('map-canvas');
    const ctx = canvas.getContext('2d');
    const S = CONFIG.WORLD_SIZE;
    const px = (x) => (x / S + 0.5) * canvas.width;
    const pz = (z) => (z / S + 0.5) * canvas.height;
    ctx.fillStyle = '#2d5e18';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c9b98a';
    ctx.beginPath();
    ctx.arc(px(0), pz(0), 16 / S * canvas.width, 0, 7);
    ctx.fill();
    for (const b of BUILDINGS) {
        ctx.fillStyle = '#' + b.color.toString(16).padStart(6, '0');
        ctx.fillRect(px(b.x - b.w / 2), pz(b.z - b.d / 2), b.w / S * canvas.width, b.d / S * canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(b.name, px(b.x), pz(b.z - b.d / 2) - 4);
    }
    ctx.fillStyle = '#7a6a4a';
    for (const h of World.houses.values()) ctx.fillRect(px(h.x) - 2, pz(h.z) - 2, 5, 5);
    ctx.fillStyle = '#ffe599';
    for (const npc of World.npcs.values()) ctx.fillRect(px(npc.x) - 2, pz(npc.z) - 2, 4, 4);
    ctx.fillStyle = '#00ffff';
    for (const p of World.players.values()) ctx.fillRect(px(p.x) - 3, pz(p.z) - 3, 6, 6);
    // self as arrow
    const s = World.self;
    ctx.save();
    ctx.translate(px(s.x), pz(s.z));
    ctx.rotate(-s.ry + Math.PI);
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(-5, 6);
    ctx.fill();
    ctx.restore();
}

function toggleMap(force) {
    mapOpen = force !== undefined ? force : !mapOpen;
    $('map-overlay').classList.toggle('hide', !mapOpen);
    if (mapOpen) drawMap();
}

// --- wiring ------------------------------------------------------------------

export function init() {
    World.on('chat', addChatRow);
    World.on('feed', addKillFeedRow);
    World.on('round', showRoundSplash);
    World.on('score', () => {
        if (!$('score-overlay').classList.contains('hide')) renderScore();
    });
    $('block-pill').addEventListener('click', () => toggleScore());
    $('kills-pill').addEventListener('click', () => toggleScore());
    $('score-overlay').addEventListener('click', () => toggleScore(false));
    let flashT = null;
    World.on('fx', (fx) => {
        if (fx.type === 'landed') toast(`🎯 Hit ${fx.name}!`, 'success');
        else if (fx.type === 'killed') toast(`💥 DESTROYED ${fx.name}!`, 'success');
        else if (fx.type === 'selfdeath') {
            $('wasted-by').textContent = `killed by ${fx.by}`.toUpperCase();
            $('wasted-overlay').classList.remove('hide');
        }
        else if (fx.type === 'respawned') {
            $('wasted-overlay').classList.add('hide');
            toast('Back on your feet at the plaza — go find a gun', 'success');
        }
        else if (fx.type === 'hurt') {
            $('hit-flash').classList.add('on');
            clearTimeout(flashT);
            flashT = setTimeout(() => $('hit-flash').classList.remove('on'), 160);
        }
        else if (fx.type === 'armed') {
            const W = WEAPONS[fx.w];
            toast(`${W.icon} Picked up ${W.name} — SPACE / 🔥 fires`, 'success');
        }
        else if (fx.type === 'dry') toast('Out of ammo — grab another weapon', 'error');
    });
    // hold-to-fire: automatics keep shooting while the button is held
    {
        const fb = $('fire-button');
        let rep = null;
        const stop = () => { if (rep) { clearInterval(rep); rep = null; } };
        fb.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            World.fire();
            stop();
            rep = setInterval(() => World.fire(), 110);
        });
        window.addEventListener('pointerup', stop);
        fb.addEventListener('pointercancel', stop);
    }

    $('profile-close').addEventListener('click', () => $('profile-popup').classList.add('hide'));
    $('relay-pill').addEventListener('click', () => toggleRelayPanel());
    $('relay-close').addEventListener('click', () => toggleRelayPanel(false));
    $('arcade-close').addEventListener('click', closeArcade);
    $('map-toggle').addEventListener('click', () => toggleMap());
    $('view-pill').addEventListener('click', () => {
        toast(Scene.toggleFpv() ? '👁 First person — V or 👁 to switch back' : '🎥 Third person');
    });
    $('map-overlay').addEventListener('click', () => toggleMap(false));
    $('action-button').addEventListener('click', doInteract);
    $('chat-open-button').addEventListener('click', openChatInput);

    $('chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            World.sendChat($('chat-input').value);
            $('chat-input').value = '';
            closeChatInput();
        } else if (e.key === 'Escape') closeChatInput();
        e.stopPropagation();
    });

    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (e.code === 'Space' || e.code === 'KeyF') {
            const armed = World.self.weapon && !World.self.inside && !World.self.tank;
            if (World.self.tank || armed) World.fire();
            else if (e.code === 'Space') doInteract();
        } else if (e.code === 'KeyE') doInteract();
        else if (e.code === 'KeyV') Scene.toggleFpv();
        else if (e.code === 'KeyM') toggleMap();
        else if (e.code === 'Tab') { e.preventDefault(); toggleScore(true); }
        else if (e.code === 'Enter') openChatInput();
        else if (e.code === 'Escape') {
            $('profile-popup').classList.add('hide');
            toggleRelayPanel(false);
            if (!$('arcade-overlay').classList.contains('hide')) closeArcade();
            toggleMap(false);
            toggleScore(false);
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.code === 'Tab') toggleScore(false);
    });

    setInterval(() => {
        $('online-count').textContent = String(1 + World.players.size);
        if (World.round.height) {
            const mins = Math.floor((Date.now() - World.round.since) / 60000);
            $('block-pill').textContent = `⛏ ${World.round.height} · ${mins}m`;
        }
        const my = World.score.get(Nostr.identity.sessionPk);
        $('kills-pill').textContent = '💀 ' + (my ? my.kills : 0);
        if (mapOpen) drawMap();
        if (feedPanel) renderFeedPanel();
    }, 1000);
}

export function frame() {
    updateLabels();
    updateInteract();
}
