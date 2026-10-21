# Remote access through a Cloudflare Tunnel

ProjectManager can read any folder on your computer and run agent CLIs, so reaching it from the
internet needs more than a password. This is an opt-in, second exception to the "never exposed"
rule (the first is the LAN listener). Nothing in the app opens a public port: you run
`cloudflared` yourself, and it forwards to a loopback-only listener inside the app.

## What stands in front of the app

Every request, every time, must pass all four:

1. **Host**: exactly your public hostname (writes also need `https://<hostname>` as their Origin).
2. **Cloudflare Access**: a valid signed token (`Cf-Access-Jwt-Assertion`) for your team and your
   Access application's AUD tag. The app verifies it itself (RS256 only, issuer, audience, expiry),
   so a misconfigured tunnel or application still cannot get in. Your Access policy is where MFA
   lives.
3. **Email allowlist** kept in Settings. A valid token only proves Access let someone through; a
   policy set to "Everyone" must not be enough.
4. **Authenticator code**: a 6-digit one-time code (RFC 6238, Google Authenticator and similar)
   that issues a session cookie (`__Host-` prefix, Secure, HttpOnly, SameSite=Strict, 12 hours,
   sliding). The cookie only works for the email that earned it. Codes work once, even across
   restarts. Five wrong codes lock that email out for 10 minutes (20 in total locks everyone).

Settings, enrolment and the authenticator secret are only answered on this computer. Requests
that arrive through the tunnel are refused those routes.

It will not switch on until team, AUD tag, hostname, at least one email and a confirmed
authenticator code all exist. Changing any detail signs every session out.

## Setup (once, by you)

Cloudflare side (needs your Cloudflare account; the app cannot do this for you):

1. Install `cloudflared` and sign in: `cloudflared tunnel login`.
2. Create a tunnel and a DNS route, for example
   `cloudflared tunnel create projectmanager` then
   `cloudflared tunnel route dns projectmanager pm.example.com`.
3. In Zero Trust, add a **self-hosted application** for `pm.example.com`. Policy: **Allow** only
   your email(s), **Require** multi-factor authentication. Keep the session duration short.
4. Copy two values from Zero Trust: your **team name** (`<team>.cloudflareaccess.com`) and the
   application's **Application Audience (AUD) tag**.

App side:

1. Settings → **Remote access**: enter team, AUD tag, hostname and the allowed email(s), then Save.
2. **Set up authenticator**: scan the QR (drawn locally) or type the secret, then confirm with a code.
3. **Turn on remote access.** The panel shows the loopback port, for example `127.0.0.1:5380`.
4. Point the tunnel at it: in the tunnel's config, ingress `hostname: pm.example.com`,
   `service: http://127.0.0.1:5380`. Run `cloudflared tunnel run projectmanager`.
5. Open `https://pm.example.com`, pass the Access login, then type the authenticator code.

The port is remembered across restarts (it starts from the app port + 200).

## Not built

- The Cloudflare One Client (WARP) device enrolment is optional and not part of this: Access plus
  the tunnel is what protects the app. Add WARP posture rules in Zero Trust if you want them.
- No automatic tunnel installation, Windows service or DNS changes.
- Not tested against a real tunnel from the build machine: the gate is covered by tests with a
  stand-in key set (`server/remote.test.ts`), and the Cloudflare side needs your setup to verify.
