# Relay World

**Play: https://relay-world.vercel.app** — works on phones, no extension needed.

Explore the [Cool Feeds relay](wss://coolfeed.feeds.relay.tools) as a living
3D world. Every NPC is a real npub pulled off the relay, wandering the plaza
with their latest note as a speech bubble. Other players exploring at the same
time appear live. Buildings are enterable — the Tank Arena and Blake Runner
arcades run the actual games on cabinets inside, and the Cool Feeds hall shows
the relay's live feed.

Revived fork of [OGRelayWorld](https://github.com/satoshipuzzles/OGRelayWorld)
("1st Public Version") — same idea, rebuilt to actually run.

## Controls

|            | Desktop            | Mobile                    |
|------------|--------------------|---------------------------|
| Move       | WASD / arrows      | left joystick             |
| Look       | drag               | drag                      |
| Interact   | E or Space         | tap the E button          |
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
- **Multiplayer** — position and chat ride ephemeral events (never stored by
  the relay) under the `relay-world` t-tag namespace. Presence heartbeats at
  3 Hz while moving, 0.2 Hz idle; players time out after 15 s.
- **No build step** — vanilla ES modules, three.js and nostr-tools off CDN.
  Serve the directory statically and it runs.

## Development

```sh
python3 -m http.server 4390   # then open http://127.0.0.1:4390
```

`#guest` on the URL skips the login screen. `window.__rw` exposes world state
in the console for poking around.
