# Chaser Zone — Vercel + Supabase Realtime

A mobile-first GPS multiplayer Runner vs Hunter game. This edition is adapted for **Vercel static hosting** and **Supabase Realtime free-tier** so it does not require a permanently running Node/Socket.IO server.

## Included

- Vercel-ready Vite build (`vercel.json` included)
- Supabase Realtime Presence for room membership and role order
- Supabase Realtime Broadcast for live GPS positions and round events
- Public room codes, invite links, copy-invite action
- Runner / Hunter roles with role swap on rematch; spectators do not transmit GPS
- Live Leaflet/OpenStreetMap player map, distance, catch radius and round timer
- 30-second head start, 10-minute round, 15-metre catch radius
- GPS accuracy and stale-fix checks
- Responsive UI, sound, vibration, fullscreen and installable PWA shell
- No user account, database schema, SQL migration, service-role key, or paid backend required

## 1. Create the free Supabase project

1. Create a project at [Supabase](https://supabase.com/dashboard) on the Free plan.
2. Open **Project Settings → API** (or **API Keys** in the current dashboard).
3. Copy the Project URL and the public `anon` / publishable key.
4. Ensure Realtime is enabled. This app uses public Realtime channels, Presence and Broadcast. It does not use database replication.
5. Read `supabase/README.md` for the security and room-access notes.

Never place a Supabase `service_role` or secret key in frontend environment variables. Only the public anon/publishable key belongs in this browser app.

## 2. Deploy to Vercel for free

1. Extract this ZIP and push the project folder to a GitHub repository.
2. Sign in at [Vercel](https://vercel.com/) and choose **Add New → Project**.
3. Import the GitHub repository. Vercel detects Vite; the included `vercel.json` sets `npm run build` and `dist`.
4. Before deploying, add these Environment Variables in Project Settings → Environment Variables:
   - `VITE_SUPABASE_URL` — your Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY` — your public anon/publishable key
5. Apply them to Production (and Preview/Development if desired), then deploy or redeploy.
6. Open the generated HTTPS URL on two or more GPS-enabled phones.

You can also run locally after creating `.env.local` from `.env.example`:

```bash
npm install
npm run dev
```

## 3. Play

1. Enter a codename. Leave the room field blank to use the `PUBLIC` room, or choose **NEW ROOM** to create a random room code.
2. Share the invite link / room code with friends.
3. The first two players in the room become Runner and Hunter; later players spectate. A rematch swaps roles.
4. The two active players grant location permission. The round starts when both have fresh GPS fixes within the configured accuracy.
5. Runner gets a 30-second head start. Hunter catches the Runner inside 15 metres. If the Runner survives 10 minutes, Runner wins.

## Free-tier notes and architecture limitations

- Vercel serves the frontend as static assets; Supabase Realtime carries Presence and Broadcast. This avoids hosting a persistent Node server.
- Supabase Free has usage quotas and project inactivity/pausing policies. Free-tier quotas can change; check the provider dashboards before a public event.
- This is a **best-effort peer-coordinated prototype**, not a server-authoritative competitive game. The earliest-joined client coordinates the start/finish events and clients calculate the catch locally. A modified client could spoof GPS or game events. For ranked/public competitive play, add an authenticated server-side authority, rate limits, moderation and durable storage.
- Public Realtime channels are discoverable by anyone who knows/guesses the room code. Do not treat room codes as access control. Do not use sensitive names or play with strangers.
- Room membership, positions and rounds are ephemeral; there are no persistent accounts, saved matches or leaderboards in this free prototype.
- Realtime events are sent only for Runner/Hunter coordinates. Spectators' location is never requested or transmitted.
- GPS requires HTTPS and browser permission. Accuracy varies by device, buildings and weather. Keep phones unlocked and use safe, open public spaces.
- Map tiles are served by OpenStreetMap and Leaflet is loaded from a public CDN; those services require internet access and have their own usage policies.

## Configuration

Game constants are in `src/app.js`:

- `MAX_PLAYERS = 40`
- `CATCH_METERS = 15`
- `MAX_ACCURACY = 40`
- `HEAD_START_MS = 30_000`
- `ROUND_MS = 600_000`
- `STALE_MS = 20_000`

## Checks

```bash
npm test
npm run build
```

`npm test` validates the retained game-engine reference tests and geospatial calculations. A successful build does not replace a live two-device test with real Supabase credentials and GPS permissions.
