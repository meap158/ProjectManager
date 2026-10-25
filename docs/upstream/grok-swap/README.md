# grok-swap (`gswap`)

Multi-account switcher for [Grok Build](https://x.ai/docs/build). Snapshot each `grok login`, then flip `~/.grok/auth.json` without a browser round-trip.

Not affiliated with xAI. Credentials never leave your machine. This repository
does not contain accounts, tokens, or anyone's `auth.json`.

## Why

Grok Build stores one OIDC session in `~/.grok/auth.json`. `grok login` replaces it. If you hold several SuperGrok seats, you want:

```text
gswap add --alias personal
grok login          # second account; do not grok logout first
gswap add --alias work
gswap switch personal
gswap list
```

## Install

```bash
uv tool install git+https://github.com/bcharleson/grok-swap
# or from a checkout:
uv tool install --editable .
```

Requires Python 3.11+ and the `grok` CLI on `PATH`.

## Commands

| Command | What it does |
|---|---|
| `gswap add [--alias NAME] [--slot N]` | Snapshot the current `grok login` |
| `gswap list` | Roster + SuperGrok credit % and reset |
| `gswap status` | Live login vs roster |
| `gswap switch` | Rotate to the next enabled account |
| `gswap switch 2` / `gswap switch you@x.com` / `gswap switch work` | Jump to one account |
| `gswap run work -- -p "hello"` | Launch `grok` as that account only (`GROK_HOME`) |
| `gswap env work` | Print `export GROK_HOME=...` for this shell |
| `gswap doctor` | Binary, auth mode, expiry, billing probe |
| `gswap alias` / `disable` / `enable` / `remove` / `purge` | Roster maintenance |

`list`, `status`, `switch`, `add`, and `doctor` accept `--json`.

## How it stores data

```text
~/.grok-swap/                 # 0700
  state.json                  # roster metadata, no tokens
  accounts/<slot>/auth.json   # 0600 copy of that account's Grok session
  homes/<slot>/               # isolated GROK_HOME used by `gswap run`
```

Override with `GSWAP_HOME`. Grok's own home is `~/.grok` or `$GROK_HOME`.

On every switch, gswap writes the *live* `auth.json` back into that account's slot first. Grok refreshes access tokens in the background; this recapture is what keeps the other seats from going stale.

## Parallel sessions

A global switch changes the default login for every `grok` on the machine. To burn two seats at once without clobbering `~/.grok`:

```bash
gswap run work --
# or
eval "$(gswap env work)"
grok
```

`gswap run` copies that account's `auth.json` into an isolated home and symlinks `config.toml` / skills / plugins from your main Grok home.

Restart already-running Grok sessions after a global `gswap switch`. The CLI may already be holding the previous bearer in memory.

## Adding more accounts

1. `gswap add` while logged in as account A.
2. `grok login` as account B. **Do not** `grok logout` first — logout can revoke the refresh token you just stored.
3. `gswap add` again.
4. Repeat. `gswap switch` from then on.

## Security

`gswap add` copies `~/.grok/auth.json` into `~/.grok-swap/` with mode `0600`.
That directory is local-only and gitignored. Never commit it, paste it into
issues, or share `gswap` debug logs that might include a bearer.

See [SECURITY.md](SECURITY.md).

## Related tools

- [`cursor-account-switcher`](https://github.com/reloadlife/cursor-account-switcher) — generic Cursor/Codex/Grok file swapper; no Grok usage dashboard
- CodexBar already reads `~/.grok/auth.json` for Grok usage; a menu-bar switcher can sit on top of this CLI later

## Development

```bash
uv sync --group dev
uv run pytest
uv tool install --editable .
```

## License

MIT
