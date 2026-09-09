/**
 * scene.js - three.js world: terrain, buildings, avatars, camera, input.
 *
 * Text (names, signs, bubbles) is DOM projected over the canvas rather than
 * canvas-texture glyphs — crisper, cheaper, and avoids WebGL text upload
 * quirks entirely.
 */
import * as THREE from 'three';
import { CONFIG, BUILDINGS } from './config.js';
import * as World from './world.js';

export let renderer, scene, camera;
const avatars = new Map(); // key -> {group, kind}
let selfAvatar = null;

// interiors live far below the map, one room per building
const INTERIOR_Y = -200;
const interiors = new Map(); // building id -> {origin: Vector3, exit: Vector3, cabinet: Vector3|null}

const keys = new Set();
let joyVec = { x: 0, y: 0 };
let dragging = false, lastDrag = null;
let camPitch = 0.35;

// --- world building ----------------------------------------------------------

function pastel(pubkey) {
    let h = 0;
    for (let i = 0; i < pubkey.length; i += 2) h = (h * 31 + parseInt(pubkey.slice(i, i + 2), 16)) >>> 0;
    return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55);
}

function makeAvatar(color, scale = 1) {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(0.6) });
    const skin = new THREE.MeshLambertMaterial({ color: color.clone().offsetHSL(0, -0.2, 0.15) });
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.4), dark);
    legs.position.y = 0.35;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.5), mat);
    body.position.y = 1.2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), skin);
    head.position.y = 2.1;
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.05), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    eyeL.position.set(-0.18, 2.15, 0.39);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.18;
    g.add(legs, body, head, eyeL, eyeR);
    g.scale.setScalar(scale);
    g.traverse(o => { o.castShadow = true; });
    return g;
}

function makeBuilding(b) {
    const g = new THREE.Group();
    const wallMat = new THREE.MeshLambertMaterial({ color: b.color });
    const walls = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), wallMat);
    walls.position.set(b.x, b.h / 2, b.z);
    walls.castShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(b.w + 2, 1.4, b.d + 2), new THREE.MeshLambertMaterial({ color: b.roof }));
    roof.position.set(b.x, b.h + 0.7, b.z);
    // door on the south face
    const door = new THREE.Mesh(new THREE.BoxGeometry(5, 6.5, 0.6), new THREE.MeshLambertMaterial({ color: 0x1a120a }));
    door.position.set(b.x, 3.25, b.z + b.d / 2 + 0.05);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(6.2, 7.4, 0.4), new THREE.MeshLambertMaterial({ color: 0xd9c86a }));
    frame.position.set(b.x, 3.7, b.z + b.d / 2 - 0.05);
    g.add(walls, roof, frame, door);

    // simple window strips
    const winMat = new THREE.MeshLambertMaterial({ color: 0xbfe8ff, emissive: 0x224455 });
    for (const side of [-1, 1]) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(b.w * 0.6, 1.6, 0.3), winMat);
        win.position.set(b.x, b.h * 0.62, b.z + side * (b.d / 2 + 0.05));
        g.add(win);
    }
    return g;
}

function makeInterior(b) {
    const g = new THREE.Group();
    const ox = b.x, oz = b.z; // reuse x/z so the minimap still makes vague sense
    const W = 22, D = 18, H = 7;
    const floorColor = b.game ? 0x24202c : 0x1c2833;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.5, D), new THREE.MeshLambertMaterial({ color: floorColor }));
    floor.position.set(ox, INTERIOR_Y - 0.25, oz);
    const wallMat = new THREE.MeshLambertMaterial({ color: b.color });
    const mkWall = (w, h, d, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        m.position.set(x, y, z);
        return m;
    };
    g.add(floor,
        mkWall(W, H, 1, ox, INTERIOR_Y + H / 2, oz - D / 2),
        mkWall(W, H, 1, ox, INTERIOR_Y + H / 2, oz + D / 2),
        mkWall(1, H, D, ox - W / 2, INTERIOR_Y + H / 2, oz),
        mkWall(1, H, D, ox + W / 2, INTERIOR_Y + H / 2, oz));
    const lamp = new THREE.PointLight(0xfff2cc, 60, 40);
    lamp.position.set(ox, INTERIOR_Y + H - 1, oz);
    g.add(lamp);

    let cabinet = null;
    if (b.game) {
        const cab = new THREE.Group();
        const bodyMat = new THREE.MeshLambertMaterial({ color: 0x18141f });
        const body = new THREE.Mesh(new THREE.BoxGeometry(3, 4.4, 2), bodyMat);
        body.position.y = 2.2;
        const screen = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.2),
            new THREE.MeshBasicMaterial({ color: b.id === 'tank-arena' ? 0x66ff88 : 0xff66dd }));
        screen.position.set(0, 2.9, 1.05);
        const marquee = new THREE.Mesh(new THREE.BoxGeometry(3, 0.7, 2.1),
            new THREE.MeshLambertMaterial({ color: 0xd9c86a, emissive: 0x554411 }));
        marquee.position.y = 4.6;
        cab.add(body, screen, marquee);
        cab.position.set(ox, INTERIOR_Y, oz - D / 2 + 2.4);
        g.add(cab);
        cabinet = new THREE.Vector3(ox, INTERIOR_Y, oz - D / 2 + 3.6);
    }

    interiors.set(b.id, {
        origin: new THREE.Vector3(ox, INTERIOR_Y, oz + D / 2 - 3),
        exit: new THREE.Vector3(ox, INTERIOR_Y, oz + D / 2 - 1.2),
        exitTo: new THREE.Vector3(b.x, 0, b.z + b.d / 2 + 4),
        cabinet,
        doorOutside: new THREE.Vector3(b.x, 0, b.z + b.d / 2 + 2),
    });
    return g;
}

export function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87c4e8);
    scene.fog = new THREE.Fog(0x87c4e8, 90, 240);

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);

    scene.add(new THREE.HemisphereLight(0xdfefff, 0x506840, 1.1));
    const sun = new THREE.DirectionalLight(0xfff4d6, 1.4);
    sun.position.set(60, 100, 40);
    scene.add(sun);

    // ground
    const S = CONFIG.WORLD_SIZE;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshLambertMaterial({ color: 0x6aa84f }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    // plaza + paths
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(16, 24), new THREE.MeshLambertMaterial({ color: 0xc9b98a }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0, 0.02, 0);
    scene.add(plaza);
    for (const b of BUILDINGS) {
        const len = Math.hypot(b.x, b.z + b.d / 2 + 4);
        const path = new THREE.Mesh(new THREE.PlaneGeometry(3.5, len), new THREE.MeshLambertMaterial({ color: 0xc9b98a }));
        path.rotation.x = -Math.PI / 2;
        path.position.set(b.x / 2, 0.02, (b.z + b.d / 2 + 4) / 2);
        path.rotation.z = -Math.atan2(b.x, b.z + b.d / 2 + 4);
        scene.add(path);
    }

    // scattered trees, deterministic
    for (let i = 0; i < 80; i++) {
        const a = i * 2.399963; // golden angle
        const r = 40 + (i * 37 % 130);
        const x = Math.cos(a) * r, z = Math.sin(a) * r - 20;
        if (World.insideBuilding(x, z, 6)) continue;
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 2.4), new THREE.MeshLambertMaterial({ color: 0x6b4a2b }));
        trunk.position.y = 1.2;
        const crown = new THREE.Mesh(new THREE.ConeGeometry(2.4 + (i % 3), 5 + (i % 4), 6), new THREE.MeshLambertMaterial({ color: i % 2 ? 0x38761d : 0x2d5e18 }));
        crown.position.y = 4.4;
        tree.add(trunk, crown);
        tree.position.set(x, 0, z);
        scene.add(tree);
    }

    for (const b of BUILDINGS) {
        scene.add(makeBuilding(b));
        scene.add(makeInterior(b));
    }

    selfAvatar = makeAvatar(new THREE.Color(0x8bac0f), 1.05);
    scene.add(selfAvatar);

    // relay jump: every avatar belonged to the old relay's world
    World.on('reset', () => {
        for (const [key, a] of avatars) {
            scene.remove(a);
            avatars.delete(key);
        }
    });

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });
    initInput(canvas);
}

// --- input -------------------------------------------------------------------

function initInput(canvas) {
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());

    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastDrag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', (e) => {
        if (!dragging || !lastDrag) return;
        const dx = e.clientX - lastDrag.x;
        const dy = e.clientY - lastDrag.y;
        lastDrag = { x: e.clientX, y: e.clientY };
        World.self.ry -= dx * 0.005;
        camPitch = Math.max(0.1, Math.min(1.1, camPitch + dy * 0.003));
    });
    window.addEventListener('pointerup', () => { dragging = false; lastDrag = null; });

    // virtual joystick
    const joy = document.getElementById('joystick');
    const knob = document.getElementById('joystick-knob');
    let joyId = null;
    joy.addEventListener('touchstart', (e) => { joyId = e.changedTouches[0].identifier; e.preventDefault(); }, { passive: false });
    joy.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) {
            if (t.identifier !== joyId) continue;
            const r = joy.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            let dx = (t.clientX - cx) / (r.width / 2);
            let dy = (t.clientY - cy) / (r.height / 2);
            const m = Math.hypot(dx, dy);
            if (m > 1) { dx /= m; dy /= m; }
            joyVec = { x: dx, y: dy };
            knob.style.transform = `translate(${dx * 30}px, ${dy * 30}px)`;
        }
        e.preventDefault();
    }, { passive: false });
    const joyEnd = (e) => {
        for (const t of e.changedTouches) {
            if (t.identifier === joyId) { joyId = null; joyVec = { x: 0, y: 0 }; knob.style.transform = ''; }
        }
    };
    joy.addEventListener('touchend', joyEnd);
    joy.addEventListener('touchcancel', joyEnd);
}

// --- interaction targets -----------------------------------------------------

/** Returns {type, label, data, dist} for the nearest interactable, or null. */
export function nearestInteractable() {
    const s = World.self;
    let best = null;
    const consider = (type, label, data, x, z, range = CONFIG.INTERACT_RANGE) => {
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < range && (!best || d < best.dist)) best = { type, label, data, dist: d };
    };

    if (s.inside) {
        const int = interiors.get(s.inside);
        const b = BUILDINGS.find(x => x.id === s.inside);
        if (int.cabinet) consider('cabinet', `PLAY ${b.game.title}`, b, int.cabinet.x, int.cabinet.z, 5);
        consider('exit', 'LEAVE BUILDING', b, int.exit.x, int.exit.z, 3.5);
        return best;
    }

    for (const b of BUILDINGS) {
        const int = interiors.get(b.id);
        consider('door', `ENTER ${b.name}`, b, int.doorOutside.x, int.doorOutside.z, 4);
    }
    for (const npc of World.npcs.values()) {
        consider('npc', `TALK TO ${World.nameOf(npc.pubkey).toUpperCase().slice(0, 18)}`, npc, npc.x, npc.z);
    }
    for (const p of World.players.values()) {
        consider('player', `GREET ${(p.name || 'WANDERER').toUpperCase().slice(0, 18)}`, p, p.x, p.z);
    }
    return best;
}

export function enterBuilding(b) {
    const int = interiors.get(b.id);
    World.self.inside = b.id;
    World.self.x = int.origin.x;
    World.self.z = int.origin.z;
}

export function exitBuilding() {
    const id = World.self.inside;
    if (!id) return;
    const int = interiors.get(id);
    World.self.inside = null;
    World.self.x = int.exitTo.x;
    World.self.z = int.exitTo.z;
}

// --- per-frame ---------------------------------------------------------------

function moveInput() {
    let fwd = 0, strafe = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
    fwd += -joyVec.y;
    strafe += joyVec.x;
    const m = Math.hypot(fwd, strafe);
    if (m > 1) { fwd /= m; strafe /= m; }
    return { fwd, strafe };
}

function tryMove(nx, nz) {
    const s = World.self;
    if (s.inside) {
        const b = BUILDINGS.find(x => x.id === s.inside);
        const W = 22 / 2 - 1.2, D = 18 / 2 - 1.2;
        s.x = Math.max(b.x - W, Math.min(b.x + W, nx));
        s.z = Math.max(b.z - D, Math.min(b.z + D, nz));
        return;
    }
    const lim = CONFIG.WORLD_SIZE / 2 - 2;
    nx = Math.max(-lim, Math.min(lim, nx));
    nz = Math.max(-lim, Math.min(lim, nz));
    const hit = World.insideBuilding(nx, nz, 1);
    if (hit) {
        // sliding: allow the axis that stays outside
        if (!World.insideBuilding(nx, s.z, 1)) { s.x = nx; return; }
        if (!World.insideBuilding(s.x, nz, 1)) { s.z = nz; return; }
        return;
    }
    s.x = nx; s.z = nz;
}

function syncAvatar(key, x, z, ry, colorSeed, scale = 1) {
    let a = avatars.get(key);
    if (!a) {
        a = makeAvatar(pastel(colorSeed), scale);
        avatars.set(key, a);
        scene.add(a);
    }
    a.position.set(x, World.self.inside && key.startsWith('sess:') ? INTERIOR_Y : 0, z);
    a.position.y = 0; // remote players/npcs stay in the overworld
    a.rotation.y = ry;
    return a;
}

export function update(dt) {
    const s = World.self;
    const { fwd, strafe } = moveInput();
    const moving = Math.abs(fwd) + Math.abs(strafe) > 0.05;
    if (moving) {
        const sin = Math.sin(s.ry), cos = Math.cos(s.ry);
        const dx = (sin * fwd + cos * strafe) * CONFIG.WALK_SPEED * dt;
        const dz = (cos * fwd - sin * strafe) * CONFIG.WALK_SPEED * dt;
        tryMove(s.x + dx, s.z + dz);
    }
    s.moving = moving;

    const baseY = s.inside ? INTERIOR_Y : 0;
    selfAvatar.position.set(s.x, baseY, s.z);
    selfAvatar.rotation.y = s.ry;
    // bob while walking
    selfAvatar.position.y = baseY + (moving ? Math.abs(Math.sin(performance.now() / 130)) * 0.18 : 0);

    for (const npc of World.npcs.values()) {
        const a = syncAvatar('npc:' + npc.pubkey, npc.x, npc.z, npc.ry, npc.pubkey, 0.95);
        a.visible = !s.inside;
    }
    for (const p of World.players.values()) {
        const a = syncAvatar('sess:' + p.pubkey, p.x, p.z, p.ry, p.mainPk || p.pubkey, 1.05);
        a.visible = !s.inside;
        a.position.y = 0;
    }
    // drop avatars for expired players
    for (const [key, a] of avatars) {
        if (key.startsWith('sess:') && !World.players.has(key.slice(5))) {
            scene.remove(a);
            avatars.delete(key);
        }
    }

    // camera: third person behind player
    const camDist = 9, camH = 3 + camPitch * 6;
    const cx = s.x - Math.sin(s.ry) * camDist;
    const cz = s.z - Math.cos(s.ry) * camDist;
    camera.position.lerp(new THREE.Vector3(cx, baseY + camH, cz), Math.min(1, dt * 10));
    camera.lookAt(s.x, baseY + 2, s.z);

    renderer.render(scene, camera);
}

/** Project a world position to screen px; null when behind the camera. */
export function toScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(camera);
    if (v.z > 1) return null;
    return {
        x: (v.x * 0.5 + 0.5) * window.innerWidth,
        y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
}

export { interiors, INTERIOR_Y };
