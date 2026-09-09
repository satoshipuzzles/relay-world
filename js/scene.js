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
const avatars = new Map(); // key -> {g, kind: 'walk'|'tank'}
let selfAvatar = null;
let selfTank = null;
const houseMeshes = new Map();  // pubkey -> group
const parkedMeshes = new Map(); // pubkey -> group
const shellMeshes = new Map();  // shell id -> mesh
const fxList = [];              // {mesh, t0, dur, grow}

// interiors live far below the map, one room per building
const INTERIOR_Y = -200;
const interiors = new Map(); // building id -> {origin: Vector3, exit: Vector3, cabinet: Vector3|null}

const keys = new Set();
let joyVec = { x: 0, y: 0 };
let dragging = false, lastDrag = null;
let camPitch = 0.35;
let velX = 0, velZ = 0, tankVel = 0; // eased self velocity
const occluders = [];   // meshes the camera should not see through
const treeList = [];    // {mesh, x, z} so house lots can clear their trees
const camRay = new THREE.Raycaster();
let sun = null;

// shared geometry — every avatar/tank/tree reuses these instead of allocating
const GEO = {
    limbLeg: null, limbArm: null, body: null, head: null, hair: null, eye: null,
    wheel: null, crown: null, trunk: null,
};

/** Small canvas noise texture so big surfaces don't read as one flat color. */
function noiseTexture(base, spread, size = 128) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const col = new THREE.Color(base);
    for (let y = 0; y < size; y += 4) {
        for (let x = 0; x < size; x += 4) {
            const n = (Math.random() - 0.5) * spread;
            ctx.fillStyle = `rgb(${(col.r + n) * 255 | 0},${(col.g + n) * 255 | 0},${(col.b + n) * 255 | 0})`;
            ctx.fillRect(x, y, 4, 4);
        }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// --- world building ----------------------------------------------------------

let wallTex = null;
/** Lambert with a shared subtle noise map so walls don't render dead flat. */
function wallMaterial(color) {
    if (!wallTex) {
        wallTex = noiseTexture(0xffffff, 0.06);
        wallTex.repeat.set(3, 3);
    }
    return new THREE.MeshLambertMaterial({ color, map: wallTex });
}

function pastel(pubkey) {
    let h = 0;
    for (let i = 0; i < pubkey.length; i += 2) h = (h * 31 + parseInt(pubkey.slice(i, i + 2), 16)) >>> 0;
    return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55);
}

function makeAvatar(color, scale = 1) {
    // rounded people: capsule limbs/torso + sphere head instead of boxes
    if (!GEO.limbLeg) {
        GEO.limbLeg = new THREE.CapsuleGeometry(0.17, 0.5, 3, 8);
        GEO.limbLeg.translate(0, -0.42, 0); // pivot at the hip
        GEO.limbArm = new THREE.CapsuleGeometry(0.12, 0.55, 3, 8);
        GEO.limbArm.translate(0, -0.44, 0); // pivot at the shoulder
        GEO.body = new THREE.CapsuleGeometry(0.36, 0.6, 4, 12);
        GEO.head = new THREE.SphereGeometry(0.4, 16, 12);
        GEO.hair = new THREE.SphereGeometry(0.42, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
        GEO.eye = new THREE.SphereGeometry(0.06, 8, 6);
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(0.6) });
    const skin = new THREE.MeshLambertMaterial({ color: color.clone().offsetHSL(0, -0.2, 0.15) });

    const legL = new THREE.Mesh(GEO.limbLeg, dark);
    legL.position.set(-0.2, 0.82, 0);
    const legR = new THREE.Mesh(GEO.limbLeg, dark);
    legR.position.set(0.2, 0.82, 0);
    const body = new THREE.Mesh(GEO.body, mat);
    body.position.y = 1.32;
    body.scale.z = 0.8;
    const armL = new THREE.Mesh(GEO.limbArm, mat);
    armL.position.set(-0.52, 1.66, 0);
    armL.rotation.z = 0.12;
    const armR = new THREE.Mesh(GEO.limbArm, mat);
    armR.position.set(0.52, 1.66, 0);
    armR.rotation.z = -0.12;
    const head = new THREE.Mesh(GEO.head, skin);
    head.position.y = 2.15;
    const hair = new THREE.Mesh(GEO.hair, dark);
    hair.position.set(0, 2.19, -0.04);
    const eyeL = new THREE.Mesh(GEO.eye, new THREE.MeshBasicMaterial({ color: 0x111111 }));
    eyeL.position.set(-0.15, 2.2, 0.35);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.15;
    g.add(legL, legR, body, armL, armR, head, hair, eyeL, eyeR);
    g.scale.setScalar(scale);
    g.traverse(o => { o.castShadow = true; });
    g.userData.limbs = { legL, legR, armL, armR };
    return g;
}

/** Swing limbs while moving; settle back when idle. */
function animateWalk(g, moving) {
    const limbs = g.userData.limbs;
    if (!limbs) return;
    const target = moving ? Math.sin(performance.now() / 110) * 0.7 : 0;
    const ease = moving ? 1 : 0.85; // snap while walking, relax when stopping
    limbs.legL.rotation.x += (target - limbs.legL.rotation.x) * ease;
    limbs.legR.rotation.x += (-target - limbs.legR.rotation.x) * ease;
    limbs.armL.rotation.x += (-target * 0.8 - limbs.armL.rotation.x) * ease;
    limbs.armR.rotation.x += (target * 0.8 - limbs.armR.rotation.x) * ease;
}

function makeTank(color, scale = 1) {
    if (!GEO.wheel) GEO.wheel = new THREE.CylinderGeometry(0.42, 0.42, 0.5, 14);
    const g = new THREE.Group();
    const hullMat = new THREE.MeshLambertMaterial({ color });
    const darkMat = new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(0.45) });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 3.6), hullMat);
    hull.position.y = 1.0;
    // sloped glacis plates front and back take the brick edge off the hull
    const glacis = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 1.0), hullMat);
    glacis.position.set(0, 0.82, 2.0);
    glacis.rotation.x = 0.55;
    const stern = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 0.9), hullMat);
    stern.position.set(0, 0.84, -1.95);
    stern.rotation.x = -0.5;
    const trackL = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 4.0), darkMat);
    trackL.position.set(-1.5, 0.55, 0);
    const trackR = trackL.clone();
    trackR.position.x = 1.5;
    for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
            const w = new THREE.Mesh(GEO.wheel, darkMat);
            w.rotation.z = Math.PI / 2;
            w.position.set(side * 1.5, 0.42, -1.35 + i * 0.9);
            g.add(w);
        }
    }
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.1, 0.6, 16), hullMat);
    turret.position.y = 1.7;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), hullMat);
    dome.position.y = 1.95;
    dome.scale.y = 0.65;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.5, 10), darkMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 1.85, 2.1);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.35, 10), darkMat);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 1.85, 3.15);
    g.add(hull, glacis, stern, trackL, trackR, turret, dome, barrel, muzzle);
    g.scale.setScalar(scale);
    g.traverse(o => { o.castShadow = true; });
    return g;
}

/** A cottage + open garage, rotated as a unit; tank spot matches world.rotY. */
function makeHouse(house) {
    const color = pastel(house.pubkey);
    const g = new THREE.Group();
    const wallMat = wallMaterial(color);
    const darkMat = new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(0.5) });
    const body = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 6), wallMat);
    body.position.y = 2.25;
    // gable roof: triangular prism with a little overhang, suburban not pyramid
    const tri = new THREE.Shape();
    tri.moveTo(-4.1, 0); tri.lineTo(4.1, 0); tri.lineTo(0, 2.7); tri.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(tri, { depth: 6.8, bevelEnabled: false });
    roofGeo.translate(0, 4.5, -3.4);
    const roof = new THREE.Mesh(roofGeo, darkMat);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, 0.8), darkMat);
    chimney.position.set(-2, 6.2, -1.4);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 0.3), new THREE.MeshLambertMaterial({ color: 0x1a120a }));
    door.position.set(0, 1.3, 3.05);
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 0.25), new THREE.MeshLambertMaterial({ color: 0xbfe8ff, emissive: 0x223344 }));
    win.position.set(2.1, 2.6, 3.05);
    // open-front garage on the right — the tank parks just outside it
    const gRoof = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.5, 5.2), darkMat);
    gRoof.position.set(5.4, 3.0, 0);
    const gBack = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.0, 0.4), wallMat);
    gBack.position.set(5.4, 1.5, -2.4);
    const gSide = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.0, 5.2), wallMat);
    gSide.position.set(7.4, 1.5, 0);
    // concrete driveway out of the garage
    const drive = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.6), new THREE.MeshLambertMaterial({ color: 0xa8a49c }));
    drive.rotation.x = -Math.PI / 2;
    drive.position.set(5.4, 0.04, 4.8);
    drive.receiveShadow = true;
    g.add(body, roof, chimney, door, win, gRoof, gBack, gSide, drive);
    g.position.set(house.x, 0, house.z);
    g.rotation.y = house.yaw;
    g.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
    return g;
}

function makeBuilding(b) {
    const g = new THREE.Group();
    const wallMat = wallMaterial(b.color);
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
    g.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
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
    const isTouch = 'ontouchstart' in window;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ec8ec);
    scene.fog = new THREE.Fog(0xa9d6ee, 100, 300);

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 900);

    // gradient sky dome: horizon haze up to a deeper zenith blue
    {
        const c = document.createElement('canvas');
        c.width = 4; c.height = 128;
        const ctx = c.getContext('2d');
        const grad = ctx.createLinearGradient(0, 128, 0, 0);
        grad.addColorStop(0, '#cfe8f4');
        grad.addColorStop(0.4, '#8ec8ec');
        grad.addColorStop(1, '#4d97d4');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 4, 128);
        const skyTex = new THREE.CanvasTexture(c);
        skyTex.colorSpace = THREE.SRGBColorSpace;
        const sky = new THREE.Mesh(
            new THREE.SphereGeometry(700, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }));
        scene.add(sky);
        // a few soft clouds
        const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: false });
        for (let i = 0; i < 9; i++) {
            const cl = new THREE.Group();
            for (let j = 0; j < 3; j++) {
                const puff = new THREE.Mesh(new THREE.SphereGeometry(9 + (i + j) % 5 * 3, 10, 8), cloudMat);
                puff.scale.y = 0.35;
                puff.position.set(j * 9 - 9, (j % 2) * 2, (j * 5) % 8);
                cl.add(puff);
            }
            const a = i * 0.7 + 0.4;
            cl.position.set(Math.cos(a) * (170 + i * 28), 95 + (i % 4) * 14, Math.sin(a) * (170 + i * 24));
            scene.add(cl);
        }
    }

    scene.add(new THREE.HemisphereLight(0xdfefff, 0x55703f, 1.0));
    sun = new THREE.DirectionalLight(0xfff4d6, 1.6);
    sun.position.set(60, 100, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60;
    sc.near = 20; sc.far = 260;
    sun.shadow.bias = -0.0006;
    scene.add(sun, sun.target);

    // ground: noise-textured grass so it doesn't read as one flat green sheet
    const S = CONFIG.WORLD_SIZE;
    const grassTex = noiseTexture(0x5f9c4b, 0.028);
    grassTex.repeat.set(40, 40);
    grassTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshLambertMaterial({ map: grassTex }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // paved town: asphalt plaza ring-road + streets with lane markings
    const asphaltTex = noiseTexture(0x46464c, 0.03);
    asphaltTex.repeat.set(6, 6);
    const asphaltMat = new THREE.MeshLambertMaterial({ map: asphaltTex });
    const paveMat = new THREE.MeshLambertMaterial({ color: 0xb3aea3 });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd8d8cf });
    const flat = (mesh, y) => { mesh.rotation.x = -Math.PI / 2; mesh.position.y = y; mesh.receiveShadow = true; return mesh; };

    // central plaza: paved circle with an asphalt ring road around it
    const plaza = flat(new THREE.Mesh(new THREE.CircleGeometry(15, 40), paveMat), 0.03);
    scene.add(plaza);
    const ring = flat(new THREE.Mesh(new THREE.RingGeometry(15, 22, 48), asphaltMat), 0.02);
    scene.add(ring);
    // dashes around the ring road centerline
    for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const dash = flat(new THREE.Mesh(new THREE.PlaneGeometry(0.35, 2.2), lineMat), 0.05);
        dash.position.set(Math.cos(a) * 18.5, 0.05, Math.sin(a) * 18.5);
        dash.rotation.z = -a + Math.PI / 2;
        scene.add(dash);
    }
    // outer suburb loop road passing through the housing belt
    const loop = flat(new THREE.Mesh(new THREE.RingGeometry(64, 71, 64), asphaltMat), 0.02);
    loop.position.set(0, 0.02, -20);
    scene.add(loop);
    for (let i = 0; i < 44; i++) {
        const a = (i / 44) * Math.PI * 2;
        const dash = flat(new THREE.Mesh(new THREE.PlaneGeometry(0.35, 2.6), lineMat), 0.05);
        dash.position.set(Math.cos(a) * 67.5, 0.05, Math.sin(a) * 67.5 - 20);
        dash.rotation.z = -a + Math.PI / 2;
        scene.add(dash);
    }
    // streets: ring road out to each town building, plus four avenues to the loop
    const street = (x0, z0, x1, z1, w = 6) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const road = flat(new THREE.Mesh(new THREE.PlaneGeometry(w, len), asphaltMat), 0.02);
        road.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
        road.rotation.z = -Math.atan2(x1 - x0, z1 - z0);
        scene.add(road);
        const n = Math.floor(len / 6);
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            const dash = flat(new THREE.Mesh(new THREE.PlaneGeometry(0.35, 2.4), lineMat), 0.05);
            dash.position.set(x0 + (x1 - x0) * t, 0.05, z0 + (z1 - z0) * t);
            dash.rotation.z = road.rotation.z;
            scene.add(dash);
        }
    };
    for (const b of BUILDINGS) {
        const dl = Math.hypot(b.x, b.z + b.d / 2 + 4) || 1;
        street(b.x / dl * 20, (b.z + b.d / 2 + 4) / dl * 20, b.x, b.z + b.d / 2 + 4, 5);
    }
    for (const a of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
        street(Math.cos(a) * 21, Math.sin(a) * 21, Math.cos(a) * 66, Math.sin(a) * 66 - 20);
    }

    // scattered trees, deterministic — leafy sphere clusters, not cones
    if (!GEO.trunk) {
        GEO.trunk = new THREE.CylinderGeometry(0.35, 0.5, 2.8, 8);
        GEO.crown = new THREE.SphereGeometry(1, 10, 8);
    }
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
    const crownMats = [new THREE.MeshLambertMaterial({ color: 0x3f7a2a }), new THREE.MeshLambertMaterial({ color: 0x33691e })];
    for (let i = 0; i < 80; i++) {
        const a = i * 2.399963; // golden angle
        const r = 26 + (i * 37 % 150);
        const x = Math.cos(a) * r, z = Math.sin(a) * r - 20;
        if (World.insideBuilding(x, z, 6)) continue;
        if (r > 60 && r < 76) continue;     // keep the loop road clear
        if (Math.hypot(x, z) < 26) continue; // and the plaza + ring road
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(GEO.trunk, trunkMat);
        trunk.position.y = 1.4;
        const s = 1.8 + (i % 3) * 0.45;
        const main = new THREE.Mesh(GEO.crown, crownMats[i % 2]);
        main.position.y = 4.2;
        main.scale.setScalar(s);
        const puffA = new THREE.Mesh(GEO.crown, crownMats[(i + 1) % 2]);
        puffA.position.set(s * 0.55, 3.6, s * 0.25);
        puffA.scale.setScalar(s * 0.62);
        const puffB = new THREE.Mesh(GEO.crown, crownMats[i % 2]);
        puffB.position.set(-s * 0.5, 3.8, -s * 0.3);
        puffB.scale.setScalar(s * 0.55);
        tree.add(trunk, main, puffA, puffB);
        tree.position.set(x, 0, z);
        tree.traverse(o => { o.castShadow = true; });
        scene.add(tree);
        treeList.push({ mesh: tree, x, z });
    }

    for (const b of BUILDINGS) {
        const bg = makeBuilding(b);
        scene.add(bg);
        occluders.push(bg);
        scene.add(makeInterior(b));
    }

    selfAvatar = makeAvatar(new THREE.Color(0x8bac0f), 1.05);
    scene.add(selfAvatar);
    selfTank = makeTank(new THREE.Color(0x8bac0f), 1.0);
    selfTank.visible = false;
    scene.add(selfTank);

    World.on('house', (h) => {
        const m = makeHouse(h);
        houseMeshes.set(h.pubkey, m);
        scene.add(m);
        occluders.push(m);
        // clear trees off the lot
        for (let i = treeList.length - 1; i >= 0; i--) {
            if (Math.hypot(treeList[i].x - h.x, treeList[i].z - h.z) < 9) {
                scene.remove(treeList[i].mesh);
                treeList.splice(i, 1);
            }
        }
    });
    World.on('park', (t) => {
        const color = t.pubkey.startsWith('left:')
            ? new THREE.Color(0x8bac0f) : pastel(t.pubkey);
        const m = makeTank(color, 0.95);
        m.position.set(t.x, 0, t.z);
        m.rotation.y = t.ry;
        parkedMeshes.set(t.pubkey, m);
        scene.add(m);
    });
    World.on('unpark', (t) => {
        const m = parkedMeshes.get(t.pubkey);
        if (m) { scene.remove(m); parkedMeshes.delete(t.pubkey); }
    });
    World.on('fx', (fx) => {
        if (fx.type === 'muzzle') spawnFx(fx.x, 1.8, fx.z, 0xffdd66, 0.5, 180);
        else if (fx.type === 'boom') spawnFx(fx.x, 1.4, fx.z, 0xff7733, fx.big ? 4.5 : 1.6, fx.big ? 550 : 320);
    });

    // relay jump: everything on screen belonged to the old relay's world
    World.on('reset', () => {
        for (const [key, a] of avatars) { scene.remove(a.g); avatars.delete(key); }
        for (const [key, m] of houseMeshes) {
            scene.remove(m);
            const i = occluders.indexOf(m);
            if (i >= 0) occluders.splice(i, 1);
            houseMeshes.delete(key);
        }
        for (const [key, m] of parkedMeshes) { scene.remove(m); parkedMeshes.delete(key); }
        for (const [key, m] of shellMeshes) { scene.remove(m); shellMeshes.delete(key); }
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

    if (s.tank) {
        // in a tank the only E-action is climbing out; firing is its own input
        return { type: 'dismount', label: 'EXIT TANK', data: null, dist: 0 };
    }

    for (const b of BUILDINGS) {
        const int = interiors.get(b.id);
        consider('door', `ENTER ${b.name}`, b, int.doorOutside.x, int.doorOutside.z, 4);
    }
    for (const t of World.parkedTanks.values()) {
        consider('tank', 'DRIVE TANK', t, t.x, t.z, 4);
    }
    for (const h of World.houses.values()) {
        const door = { x: h.x + Math.sin(h.yaw) * 3.6, z: h.z + Math.cos(h.yaw) * 3.6 };
        consider('house', `VISIT ${World.nameOf(h.pubkey).toUpperCase().slice(0, 16)}'S HOUSE`, h, door.x, door.z, 3.5);
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
    const pad = s.tank ? 1.6 : 0;
    const blocked = (x, z) => World.insideBuilding(x, z, 1 + pad) || World.insideHouse(x, z, pad);
    if (blocked(nx, nz)) {
        // already overlapping (e.g. mounted beside a garage): move freely so
        // you can drive out — re-entry stays blocked from outside
        if (blocked(s.x, s.z)) { s.x = nx; s.z = nz; return; }
        // sliding: allow the axis that stays outside
        if (!blocked(nx, s.z)) { s.x = nx; return; }
        if (!blocked(s.x, nz)) { s.z = nz; return; }
        return;
    }
    s.x = nx; s.z = nz;
}

/** Shortest-path angular ease so avatars turn smoothly instead of snapping. */
function easeAngle(cur, target, k) {
    let d = (target - cur) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return cur + d * k;
}

function syncAvatar(key, x, z, ry, colorSeed, scale = 1, kind = 'walk') {
    let a = avatars.get(key);
    if (a && a.kind !== kind) { scene.remove(a.g); avatars.delete(key); a = null; }
    if (!a) {
        const g = kind === 'tank' ? makeTank(pastel(colorSeed), scale) : makeAvatar(pastel(colorSeed), scale);
        a = { g, kind };
        avatars.set(key, a);
        scene.add(g);
        g.position.set(x, 0, z);
        g.rotation.y = ry;
    }
    const moved = Math.hypot(x - a.g.position.x, z - a.g.position.z) > 0.012;
    a.g.position.set(x, 0, z); // remote players/npcs stay in the overworld
    a.g.rotation.y = easeAngle(a.g.rotation.y, ry, 0.25);
    if (kind === 'walk') animateWalk(a.g, moved);
    return a.g;
}

function spawnFx(x, y, z, color, size, dur) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    mesh.position.set(x, y, z);
    scene.add(mesh);
    fxList.push({ mesh, t0: performance.now(), dur });
}

function stepFx() {
    const now = performance.now();
    for (let i = fxList.length - 1; i >= 0; i--) {
        const fx = fxList[i];
        const t = (now - fx.t0) / fx.dur;
        if (t >= 1) {
            scene.remove(fx.mesh);
            fxList.splice(i, 1);
            continue;
        }
        fx.mesh.scale.setScalar(1 + t * 1.8);
        fx.mesh.material.opacity = 0.95 * (1 - t);
    }
}

function syncShells() {
    for (const [id, sh] of World.shells) {
        let m = shellMeshes.get(id);
        if (!m) {
            m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6),
                new THREE.MeshBasicMaterial({ color: 0xffe599 }));
            shellMeshes.set(id, m);
            scene.add(m);
        }
        m.position.set(sh.x, 1.7, sh.z);
    }
    for (const [id, m] of shellMeshes) {
        if (!World.shells.has(id)) { scene.remove(m); shellMeshes.delete(id); }
    }
}

export function update(dt) {
    const s = World.self;
    const { fwd, strafe } = moveInput();
    const moving = Math.abs(fwd) + Math.abs(strafe) > 0.05;
    if (s.tank) {
        // tank controls: A/D (or joystick x) steer, W/S throttle, with a
        // little engine spool so it feels like driving a heavy thing
        if (Math.abs(strafe) > 0.05) s.ry -= strafe * CONFIG.TANK_TURN * dt;
        const targetVel = Math.abs(fwd) > 0.05 ? fwd * (fwd > 0 ? CONFIG.TANK_SPEED : CONFIG.TANK_REVERSE) : 0;
        tankVel += (targetVel - tankVel) * Math.min(1, dt * 4);
        if (Math.abs(tankVel) > 0.15) {
            tryMove(s.x + Math.sin(s.ry) * tankVel * dt, s.z + Math.cos(s.ry) * tankVel * dt);
        }
        velX = velZ = 0;
    } else {
        // walking accelerates/brakes over a few frames instead of snapping.
        // Camera-right in world space is (-cos ry, +sin ry) for a camera that
        // sits behind the player looking along (+sin ry, +cos ry).
        const sin = Math.sin(s.ry), cos = Math.cos(s.ry);
        const tx = moving ? (sin * fwd - cos * strafe) * CONFIG.WALK_SPEED : 0;
        const tz = moving ? (cos * fwd + sin * strafe) * CONFIG.WALK_SPEED : 0;
        const k = Math.min(1, dt * 11);
        velX += (tx - velX) * k;
        velZ += (tz - velZ) * k;
        if (Math.hypot(velX, velZ) > 0.15) tryMove(s.x + velX * dt, s.z + velZ * dt);
        tankVel = 0;
    }
    s.moving = moving;

    const baseY = s.inside ? INTERIOR_Y : 0;
    selfAvatar.visible = !s.tank;
    selfTank.visible = s.tank && !s.inside;
    if (s.tank) {
        selfTank.position.set(s.x, 0, s.z);
        selfTank.rotation.y = s.ry;
    } else {
        selfAvatar.position.set(s.x, baseY, s.z);
        selfAvatar.rotation.y = s.ry;
        // bob while walking
        selfAvatar.position.y = baseY + (moving ? Math.abs(Math.sin(performance.now() / 130)) * 0.18 : 0);
        animateWalk(selfAvatar, moving);
    }

    for (const npc of World.npcs.values()) {
        const a = syncAvatar('npc:' + npc.pubkey, npc.x, npc.z, npc.ry, npc.pubkey, 0.95);
        a.visible = !s.inside;
    }
    for (const p of World.players.values()) {
        const a = syncAvatar('sess:' + p.pubkey, p.x, p.z, p.ry, p.mainPk || p.pubkey, p.tank ? 1.0 : 1.05, p.tank ? 'tank' : 'walk');
        a.visible = !s.inside;
    }
    // drop avatars for expired players
    for (const [key, a] of avatars) {
        if (key.startsWith('sess:') && !World.players.has(key.slice(5))) {
            scene.remove(a.g);
            avatars.delete(key);
        }
    }

    syncShells();
    stepFx();

    // keep the sun (and its shadow frustum) centred on the player so shadows
    // stay sharp across the whole 400m world
    sun.position.set(s.x + 60, 100, s.z + 40);
    sun.target.position.set(s.x, 0, s.z);

    // camera: third person behind player (further back in a tank), pulled in
    // when a house or building sits between the camera and the player
    const camDist = s.tank ? 13 : 9, camH = (s.tank ? 4.5 : 3) + camPitch * 6;
    const eye = new THREE.Vector3(s.x, baseY + 2, s.z);
    let desired = new THREE.Vector3(s.x - Math.sin(s.ry) * camDist, baseY + camH, s.z - Math.cos(s.ry) * camDist);
    if (!s.inside && occluders.length) {
        const dir = desired.clone().sub(eye);
        const len = dir.length();
        dir.normalize();
        camRay.set(eye, dir);
        camRay.far = len;
        const hits = camRay.intersectObjects(occluders, true);
        if (hits.length) {
            // park the camera just in front of whatever is in the way — a
            // brief close-up beats a wall filling the screen, and it relaxes
            // as soon as the player moves clear
            desired = eye.clone().add(dir.multiplyScalar(Math.max(2.5, hits[0].distance - 0.6)));
        }
    }
    camera.position.lerp(desired, Math.min(1, dt * 10));
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
