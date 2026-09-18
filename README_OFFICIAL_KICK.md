# Khaled Hallowen Kick — Official Kick API integration

This bundle adds an official Kick OAuth 2.1 + PKCE backend to the existing site.

## Files

- `Khaled_Hallowen_Kick_OFFICIAL.html` — your existing site with a small official Kick login/status bridge.
- `server.js` — OAuth 2.1 + PKCE, session handling, and official Kick API calls.
- `package.json` — Node dependencies and start command.
- `.env.example` — environment-variable template.

## Setup

1. Copy `.env.example` to `.env`.
2. Put your **Kick Client ID** in `KICK_CLIENT_ID`.
3. Put your **Kick Client Secret** in `KICK_CLIENT_SECRET`.
4. In Kick Developer, set the Redirect URL to the exact value in `KICK_REDIRECT_URI`.
5. Run:
   `npm install`
   `npm start`
6. Put the HTML file and the `RedKick_files` folder inside `public/`.

Recommended final structure:

public/
  index.html
  RedKick_files/

server.js
package.json
.env

The server uses the official Kick OAuth server at `id.kick.com` and the public API at `api.kick.com`.

Important: never place the Client Secret, access token, or refresh token inside HTML/JavaScript shipped to the browser.

The current site still contains its old proxy/private-endpoint bot engine. This bundle does not claim that engine is an official Kick API integration. The official portion here is the OAuth/API backend only.
