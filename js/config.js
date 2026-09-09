/**
 * config.js - Relay World configuration
 */
export const CONFIG = {
    // The world relay. Everything — feed NPCs, presence, chat — lives here.
    RELAY: 'wss://coolfeed.feeds.relay.tools',

    // Ephemeral kinds (20000-29999): relays forward but never store them,
    // so presence and chat cost the relay nothing at rest.
    KIND_PRESENCE: 21150,
    KIND_CHAT: 21151,
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
