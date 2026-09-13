/**
 * config.js - Relay World configuration
 */
export const CONFIG = {
    // The default world relay. Everything — feed NPCs, presence, chat — lives
    // on whichever relay is active; switching relays swaps the whole world.
    RELAY: 'wss://coolfeed.feeds.relay.tools',

    // Read-only fallbacks for kind-0 metadata: the world relay carries few
    // profiles, and NPCs deserve names and faces. Queries are batched; the
    // first relay that connects wins.
    PROFILE_RELAYS: ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://relay.nostr.band'],

    // Ephemeral kinds (20000-29999): relays forward but never store them,
    // so presence and chat cost the relay nothing at rest.
    //
    // Cool Feeds gates writes behind a web of trust but whitelists kinds
    // 21000-21002 for unknown keys (measured 2026-09-08; the tank game's
    // netcode lives there). Relay World rides that window, namespaced by the
    // `t` tag so tank clients (which filter on room tags) never see these.
    // If the operator whitelists 21150/21151, move to dedicated kinds.
    KIND_PRESENCE: 21000,
    KIND_CHAT: 21001,
    KIND_ACTION: 21002,       // tank combat: shots, hits, kills
    TAG: 'relay-world',

    // Feed content that populates the world with NPCs.
    FEED_KINDS: [0, 1],
    FEED_LIMIT: 200,
    NPC_LIMIT: 60,

    WORLD_SIZE: 400,          // metres, square
    PRESENCE_HZ: 3,           // position publish rate while moving
    PRESENCE_IDLE_MS: 5000,   // heartbeat when idle
    PRESENCE_TIMEOUT_MS: 15000,

    INTERACT_RANGE: 4.5,      // metres
    LABEL_RANGE: 30,          // show name labels within this range
    BUBBLE_RANGE: 24,         // show note bubbles within this range

    WALK_SPEED: 8,            // m/s

    // Tank combat
    TANK_SPEED: 16,           // m/s
    TANK_REVERSE: 7,          // m/s
    TANK_TURN: 2.4,           // rad/s
    SHELL_SPEED: 42,          // m/s
    SHELL_RANGE: 100,         // metres before a shell fizzles
    SHELL_DMG: 25,
    SHELL_HIT_RADIUS: 2.6,    // metres
    FIRE_COOLDOWN_MS: 900,
    MAX_HP: 100,

    // Grand Theft Relay: on-foot deathmatch
    PICKUPS_PER_ROUND: 16,    // weapons lying around the map
    PICKUP_RADIUS: 1.7,       // walk this close to grab one
    PICKUP_RESPAWN_MS: 30000, // a grabbed weapon reappears for others
    BULLET_HIT_RADIUS: 1.3,   // metres (people are smaller than tanks)
};

// The on-foot arsenal. Damage/fire-rate trade off Quake-style; every stat the
// victim needs to simulate a shot deterministically lives here, so the wire
// format only ever names the weapon.
export const WEAPONS = {
    pistol:  { name: 'PISTOL',   icon: '🔫', color: 0x9aa7b8, dmg: 15,  speed: 55, range: 65,  cooldown: 320,  ammo: 24, pellets: 1, spread: 0.015 },
    smg:     { name: 'SMG',      icon: '⚡', color: 0xf2c14e, dmg: 8,   speed: 60, range: 45,  cooldown: 115,  ammo: 60, pellets: 1, spread: 0.07 },
    shotgun: { name: 'SHOTGUN',  icon: '🧨', color: 0xd35d3a, dmg: 11,  speed: 48, range: 26,  cooldown: 850,  ammo: 12, pellets: 5, spread: 0.14 },
    rifle:   { name: 'SNIPER',   icon: '🎯', color: 0x5dd39e, dmg: 45,  speed: 95, range: 140, cooldown: 1150, ammo: 10, pellets: 1, spread: 0 },
    rocket:  { name: 'ROCKET',   icon: '🚀', color: 0xc95df0, dmg: 100, speed: 28, range: 90,  cooldown: 1700, ammo: 4,  pellets: 1, spread: 0, blast: 5 },
};

// World relays the player can jump between. Each one is its own shard: the
// npubs walking around are that relay's authors, and presence/chat only meet
// players on the same relay. (Primal deliberately absent — owner request.)
export const RELAYS = [
    { name: 'COOL FEEDS', url: 'wss://coolfeed.feeds.relay.tools' },
    { name: 'DAMUS', url: 'wss://relay.damus.io' },
    { name: 'NOS.LOL', url: 'wss://nos.lol' },
    { name: 'NOSTR.WINE', url: 'wss://nostr.wine' },
    { name: 'OFFCHAIN', url: 'wss://offchain.pub' },
];

// Buildings players can walk into. Doors face +z (south, toward spawn).
export const BUILDINGS = [
    {
        id: 'tank-arena',
        name: 'TANK ARENA',
        x: -46, z: -52, w: 34, d: 26, h: 14,
        color: 0x4a5d3a, roof: 0x2f3d24, sign: '⚔ TANK ARENA',
        game: { title: 'NOSTR TANK ARENA', url: 'https://nostr-tank-arena.vercel.app' },
    },
    {
        id: 'blake-arcade',
        name: 'BLAKE RUNNER',
        x: 46, z: -52, w: 26, d: 22, h: 16,
        color: 0x3d2a5d, roof: 0x241738, sign: '▲ BLAKE RUNNER',
        game: { title: 'BLAKE RUNNER', url: 'https://forever21.lol/game' },
    },
    {
        id: 'feed-hall',
        name: 'COOL FEEDS HALL',
        x: 0, z: -84, w: 44, d: 30, h: 20,
        color: 0x2a4a5d, roof: 0x16303f, sign: '⚡ COOL FEEDS',
        game: null, // interior shows the live feed instead
    },
];
