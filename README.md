# Taste Bridge

Taste Bridge helps a group of 3–6 friends decide what to do together. Friends
confirm a few Qloo entities they like; the app finds group recommendations and
shows both the Qloo taste-overlap score and the AI-written explanation.

## Stack

- npm workspaces: `shared`, `server`, and `web`
- Fastify API and React/Vite/Tailwind web app, served by one Node process
- SQLite via `better-sqlite3` (one server instance with a persistent local disk)
- Qloo entity search over its hackathon API and recommendations through the
  local Qloo MCP harness
- Optional Gemini-written per-friend reasons; headlines are derived from the
  selected Qloo pick and overlap score, and deterministic reasons are used when
  Gemini is unavailable or returns invalid output

## Requirements

- Node.js 22.19 or later and npm
- Qloo hackathon API credentials for entity search and recommendations
- Optional `GEMINI_API_KEY` for AI-written explanations

Install packages and copy `.env.example` to `.env`, then add your private key
locally. Never commit `.env` or put credentials in browser code:

```powershell
npm install
Copy-Item .env.example .env
```

Install and configure the Qloo harness using its private setup prompt. The
application starts the local `qloo mcp` process as a child of the API:

```powershell
npm install --global @qloo/qloo-harness
qloo setup --qloo
qloo setup --status
```

Configure the hackathon endpoint URLs if they are not already present in your
environment:

```powershell
[Environment]::SetEnvironmentVariable("QLOO_BASE_URL", "https://hackathon.api.qloo.com", "User")
[Environment]::SetEnvironmentVariable("QLOO_TRUSTED_BASE_URL", "https://hackathon.api.qloo.com", "User")
```

The key itself belongs in the Qloo harness's private configuration or in the
server-only `QLOO_API_KEY` variable in `.env`. `.env.example` contains
placeholders only.

## Run locally

```powershell
npm run dev
```

Open <http://localhost:5173>. The Vite development server proxies `/api` to
Fastify on port 4000. To run only the compiled production app:

```powershell
npm run build
npm start
```

Fastify serves the built web app and API together on port 4000 by default. The
health endpoint is `/api/health`. Set `PORT` to change the listener port.

## Room flow

1. Create a room, choose one or more planning categories, and enter a city or
   area if dining is selected.
2. Share the room link. Friends join with unique nicknames; no account is
   needed. Joined members can chat in the room while coordinating.
3. Each person searches Qloo for places, artists, movies, or cuisine/style tags,
   confirms 2–4 matches, and saves their favorites. Matches are never silently
   auto-selected.
4. Once at least three people are ready, the creator generates the plan.
5. Joined members can see each pick, its separate Qloo and AI evidence, vote,
   and request a new set. Regenerated picks are excluded from later plans.

The shared link shows a minimal room preview (categories, coarse city/area,
and member/ready counts). Joining is required to see the roster, favorites,
plan, votes, or chat. API traffic is limited to 120 requests per client address
per minute, Qloo searches to 20 per member per minute, and plan regeneration has
a 30-second cooldown after a completed generation. These in-memory limits are
per server process and reset when it restarts.

The app stores no precise coordinates, accounts, emails, or device identifiers.
Only public Qloo entities and (for dining) the city/area are used for
recommendations. If a creator opts to use browser location, raw coordinates
are sent once to OpenStreetMap Nominatim to derive the city/area; the app
does not store those coordinates or send them to Qloo. Nicknames are not sent
to Qloo or Gemini. Room chat is visible only to members who joined that room;
messages are plain text, limited to 500 characters, and deleted with the room.
Rooms and their dependent data expire after 72 hours by default;
`ROOM_TTL_HOURS` can be set to an integer from 24–168. SQLite is created at `data/taste-bridge.db` by default;
`DATABASE_PATH` can point to an absolute path or a path relative to the repo
root. Back up persistent storage if you need it—there is no account-based
history.

Run a single server instance with a persistent disk. SQLite and the local Qloo
MCP process are intentionally not configured for serverless or multi-instance
hosting.

### Docker

Build and run the single-process container with a persistent named volume.
Supply secrets at runtime through the ignored local `.env` file or your hosting
platform’s secret manager:

```powershell
docker build -t taste-bridge .
docker run --name taste-bridge --env-file .env -p 4000:4000 -v taste-bridge-data:/app/data taste-bridge
```

Use one replica and persistent storage. The image includes the Qloo harness
CLI, but not credentials; set `QLOO_API_KEY` and both Qloo base URL variables
at runtime. Serve it behind HTTPS in production so room cookies use the Secure
attribute.

## Development checks

```powershell
npm test
npm run build
npm audit
```

`npm run qloo:smoke` checks the Qloo MCP tag workflow and stores a fixture only
when the live request succeeds. Do not fabricate fixtures when API
authentication is unavailable.

`npm run demo:plan` runs the earlier three-profile engine walkthrough. Its
sample-catalog picks are explicitly labeled when the Qloo API is unavailable;
it does not alter or seed live rooms.

## Product requirements

See [docs/PRD.md](./docs/PRD.md) for the version-one product requirements.

Taste overlap reflects aggregate recommendation affinity, not a promise that
anyone will enjoy a pick. The UI labels Qloo evidence and AI explanations
separately.
