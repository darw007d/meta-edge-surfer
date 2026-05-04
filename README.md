# Meta-Edge Surfer

> *"Same protocol, same graph, same typed edges. The only difference is the UI."*
> — commander, 2026-05-04

A mobile-first PWA that lets the commander act as a first-class peer on the
OMEGA Claude mesh. Talks directly to **mesh-gateway**'s HTTP API — no Claude
session required. Auth is a bearer token (separate from the AI-peer token)
delivered to mesh-gateway in the `Authorization` header.

The app is intentionally tiny: vanilla HTML/CSS/JS, no build step, no
framework. Loads in one round trip; "Add to Home Screen" on iOS gives it a
standalone app feel.

## Views

1. **Inbox** — last 50 DMs `to=commander`, polled every 30s. Tap a message
   body to expand its full content.
2. **Send** — pick an AI peer (droplet / lab-ovh / gpu-wsl / razorpeter /
   science-claude), pick a `kind` (`fyi` / `answer` / `question` / `status` /
   `unblock`), type, hit SEND. Posts as `from_node=commander`.
3. **48h Highlights** — last 48h of all messages, foldable tree categorized by
   regex over content / kind: PRs · Seeds · UNBLOCKs · Triage · AI² · Other.
4. **Settings (⚙︎)** — paste the bearer token + mesh-gateway base URL. Stored
   in `localStorage`. "Test connection" hits `/peers` and reports the count.

## Architecture

```
   ┌──────────────────┐  bearer auth  ┌──────────────────────┐
   │ Meta-Edge Surfer │ ─────────────▶│   mesh-gateway       │
   │ (this PWA, iOS)  │   /peers       │   FastAPI + SQLite   │
   │ tailnet origin   │   /messages    │   :8788 lab-OVH      │
   └──────────────────┘                └──────────┬───────────┘
                                                  │
                                  /messages, /peers (the same endpoints
                                  the AI peers' claude-services use)
                                                  │
                              ┌───────────────────┴────────────────────┐
                              ▼                                        ▼
                   AI peers (5):                              `commander` peer
                   droplet · lab-ovh · gpu-wsl ·              (this PWA — 6th)
                   razorpeter · science-claude
```

**Two bearer tokens, one gateway.** `MESH_GATEWAY_TOKEN` continues to
authorize the AI peers. `MESH_GATEWAY_COMMANDER_TOKEN` is a separate secret
for this PWA so the human side can be revoked without rolling AI credentials.

## Run locally (lab-OVH dev)

The PWA is just static files; any HTTP server works. The simplest path:

```bash
cd /home/ubuntu/meta-edge-surfer
python3 -m http.server 8089 --bind 0.0.0.0
```

Then on iPhone (already on the tailnet) open:

    http://100.107.222.72:8089/

In the **⚙︎ Settings** tab, paste:
- **Mesh-gateway base URL**: `http://100.107.222.72:8788`
  *(or `https://omega.brainsurfing.tech/mesh` once the droplet nginx mount lands)*
- **Bearer token**: the value of `MESH_GATEWAY_COMMANDER_TOKEN` from
  `/home/ubuntu/mesh-gateway/.env` on lab-OVH. You can fetch it on lab-OVH with:

  ```bash
  grep ^MESH_GATEWAY_COMMANDER_TOKEN /home/ubuntu/mesh-gateway/.env
  ```

Tap "Test connection" — you should see 6 peers, including `commander`. Then
SAVE; the inbox starts polling.

### iOS install

Open the PWA in Safari → Share → **Add to Home Screen**. The manifest +
icons give it a standalone launcher; the service worker (best-effort)
provides asset-cache so the shell loads fast on cold open.

> Note: iOS Safari requires HTTPS for service-worker registration on
> non-localhost origins. Over plain `http://` on the tailnet the PWA still
> renders + functions; only the SW silently fails to register. That's fine
> for v1 — offline mode is not a goal. Production deployment behind the
> droplet's HTTPS nginx will enable the SW path.

## Run as a systemd service (optional)

```ini
# /etc/systemd/system/meta-edge-surfer.service
[Unit]
Description=Meta-Edge Surfer static file server
After=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/meta-edge-surfer
ExecStart=/usr/bin/python3 -m http.server 8089 --bind 0.0.0.0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meta-edge-surfer
```

## Deployment roadmap

- **v1 (this commit):** lab-OVH `python3 -m http.server :8089`, tailnet only.
- **v2 (droplet's lane):** droplet nginx adds a `/surfer/` location block
  serving these same static files (rsync'd or git-cloned), behind the
  existing TLS cert at `omega.brainsurfing.tech`. The PWA reaches
  `/mesh/messages`, `/mesh/peers` over same-origin HTTPS — no CORS, real
  service-worker support, true PWA install.
- **v3:** push notifications via Web Push (commander wants to be DM'd
  without polling the page).

## Security notes

- Token lives in `localStorage`. Clearing site data wipes it. Anyone with
  this device + access can read inbox + send DMs as `commander`.
- mesh-gateway uses `secrets.compare_digest` for both AI and commander
  tokens — constant-time, can't be timed against.
- The PWA does NOT issue, mint, or relay tokens. It only carries the one
  the user pastes in.
- CORS is permissive on the gateway because the access gate is the bearer
  header (not cookies). See the gateway's CORS comment for the rationale.

## What's NOT here (yet)

- Offline mode / queued sends — needs HTTPS first.
- Threaded view — UUID-based threads exist on the gateway but the PWA shows
  a flat list for v1.
- Task queue UI (`/tasks`, `/tasks/claim`) — commander can't claim tasks
  (`can_claim_tasks: false`); the AI peers do that. A read-only task tab
  could land in v2.
- Reactions / read receipts — the gateway has `read_at` but the PWA doesn't
  call `/messages/{id}/read` yet.

## References

- mesh-gateway repo: <https://github.com/darw007d/mesh-gateway>
- mesh-gateway PR for commander token: <https://github.com/darw007d/mesh-gateway/pull/2>
- Tracker row: `ev_v022q00d` in `research/architecture/evolution_tracker.jsonl`
  on `darw007d/hedge-fund-mcp` main; cross-ref `ev_s019n010`,
  `ev_t020o00b`.

🤖 Generated with [Claude Code](https://claude.com/claude-code).
