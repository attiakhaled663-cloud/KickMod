# Kick Mod — Official API

A mobile-first dark UI inspired by the supplied screenshots, with a real server-side backend. It uses only Kick's documented OAuth/API surfaces for authentication, channels, livestream status, and chat posting.

## Official API surfaces used
- OAuth 2.1 at `https://id.kick.com` with PKCE.
- API base `https://api.kick.com/public/...`.
- `GET /public/v1/users` for account validation.
- `GET /public/v1/channels?slug=...` for channel lookup.
- `GET /public/v2/livestreams?broadcaster_user_id=...` for live status.
- `POST /public/v1/chat` with `chat:write` for sending a message.
- `POST /oauth/token` refresh grant for refreshing access tokens.

## Run

1. Install Node.js 18+.
2. Copy `.env.example` to `.env` and set your Kick Client ID/Secret, Redirect URI, and encryption secret.
3. In the Kick Developer Portal, register the Redirect URI exactly.
4. Start with `npm start`.
5. Open `http://localhost:3000`.

## Important
Tokens are stored encrypted on the server. Do not commit `.env` or `data.json` to Git. For production, put the app behind HTTPS and use a proper database/secrets manager.

This build deliberately avoids Kick's undocumented internal web endpoints. For live-status updates, the UI refreshes every 45 seconds as requested. A webhook can be added later as an optimization, but the core control path remains on documented API endpoints.
