# Relay World

**Play: https://relay-world.vercel.app** — works on phones, no extension needed.

Explore Nostr relays as living 3D worlds. Every NPC is a real npub pulled off
the active relay, wandering the plaza with their latest note as a speech
bubble — and every npub owns a pastel cottage with a garage and a tank parked
out front. Hop in any tank, drive around, and shoot other players: combat is
live multiplayer over the relay. Jump between relays (Cool Feeds is the
default) and the whole world repopulates with that relay's people. Buildings
are enterable — the Tank Arena and Blake Runner arcades run the actual games
on cabinets inside, and the Cool Feeds hall shows the relay's live feed.

Revived fork of [OGRelayWorld](https://github.com/satoshipuzzles/OGRelayWorld)
("1st Public Version") — same idea, rebuilt to actually run.

## Controls

|            | Desktop            | Mobile                    |
|------------|--------------------|---------------------------|
| Move       | WASD / arrows      | left joystick             |
| Look       | drag               | drag                      |
| Interact   | E or Space         | tap the E button          |
| Drive tank | E near a tank      | tap E near a tank         |
| Fire       | Space or F         | tap 🔥                    |
| Jump relay | click the ⚡ pill  | tap the ⚡ pill           |
| Chat       | Enter              | tap 💬                    |
| Map        | M                  | tap 🗺️                    |

## How it works

- **Login** — NIP-07 extension (one prompt, for your pubkey only) or guest
  mode. Either way a throwaway session key signs all game traffic, so playing
  never spams your signer.
- **NPCs** — kind 0/1 events from Cool Feeds. Each author gets a deterministic
  home spot hashed from their pubkey. Names and avatars are backfilled from
  profile relays (purplepag.es → damus → nostr.band) with a batched read-only
  query.
- **Multiplayer** — position, chat, and tank combat ride ephemeral events
  (never stored by the relay) under the `relay-world` t-tag namespace.
  Presence heartbeats at 3 Hz while moving, 0.2 Hz idle; players time out
  after 15 s. Combat is victim-authoritative: every client simulates shells,
  the player who gets hit announces the damage.
- **Relay jumping** — the ⚡ pill switches the world relay; live
  subscriptions replay on the new socket and the world rebuilds. Logged-in
  users' kind-3 follows get a gold ★ wherever they appear.
- **No build step** — vanilla ES modules, three.js and nostr-tools off CDN.
  Serve the directory statically and it runs.

## Development

```sh
python3 -m http.server 4390   # then open http://127.0.0.1:4390
```

`#guest` on the URL skips the login screen. `window.__rw` exposes world state
in the console for poking around.
