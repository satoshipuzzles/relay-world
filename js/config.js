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
