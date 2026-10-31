# Supabase setup (free tier)

Chaser Zone uses Supabase **Realtime Presence + Broadcast** only. It does not need a database table, SQL migration, Edge Function, service-role key, or paid server. Room membership and game state are ephemeral and disappear when everyone leaves or the Realtime service drops the channel.

1. Create a project at https://supabase.com/dashboard (the Free plan is sufficient for testing; quotas and inactivity/pause rules apply).
2. Open **Project Settings → API** (or **API Keys** in the newer dashboard).
3. Copy the Project URL and the public `anon` / publishable key. Never use a `service_role` or secret key in a browser app.
4. In the Supabase dashboard, make sure Realtime is enabled for the project. The app uses public Realtime channels (`private: false`) and does not use Postgres Changes.
5. In Vercel → Project → Settings → Environment Variables, add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your public anon/publishable key
6. Apply the variables to Production, Preview, and Development as needed, then redeploy.

## Important channel access setting

The game uses public room channels so players can join without accounts. Anyone who knows or guesses a room code may subscribe and observe the room's active players' GPS broadcasts. Use non-sensitive room codes and only play with people you trust. This is a prototype-friendly, no-login architecture, not a private or abuse-resistant matchmaking system.
