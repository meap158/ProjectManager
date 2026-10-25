# Native Grok accounts (PM-254)

Settings → Agents → Grok → Accounts uses the same account layout and actions as the other native switchers. It detects the default login, displays its email, saves/imports profiles, supports nicknames and drag reordering, and refreshes all or individual usage reports. Switching requires confirmation. Already running Grok processes retain their login until deliberately restarted; ProjectManager does not restart them automatically.

The credential location follows Grok: `GROK_HOME`, then `GROK_CONFIG_DIR`, then `~/.grok`, with `auth.json` inside. Supported OIDC entries use the exact HTTPS origins `auth.x.ai` or `accounts.x.ai`. The original document is preserved so refresh and provider metadata survive a switch. API-key-only logins have no verified account/billing contract and are not offered as saved accounts.

Saved credentials and the previous-login backup are encrypted with AES-256-GCM in `data/grok-accounts/*.enc`. The separate `encryption.key` must be backed up with these files. Registry metadata contains no tokens or cached quota. Encryption protects stored copies; anyone with access to both the key and ciphertext can decrypt them. The live Grok auth file remains in Grok's own format. Removing a saved profile does not sign out the active CLI.

Usage comes directly from Grok's billing service using that profile's bearer credential. The percentage is credits **used**, not credits remaining. Plan metadata is optional. Usage is cached in memory for at most 60 seconds before marked stale and automatically refreshed while the drawer is open. Manual refresh requests fresh provider data. Identity includes issuer, principal and team; cache entries also require an identical credential fingerprint. Failed, expired or malformed responses show unknown usage rather than zero. Reset times come from the provider and use the shared live countdown; reaching a reset never invents a replenished quota. No automatic account rotation is implemented without a verified Grok exhaustion signal.

Switching saves the current CLI's latest credential before replacement and verifies the write. A concurrent external login aborts the switch. If a write fails, the previous credential is restored. Missing encryption keys fail closed: restore the key and encrypted files together from backup, or remove the damaged saved profile and save a fresh `grok login`. Do not share these files or commit them.

## Reference and validation

`grok-swap` is a useful reference for Grok Build OIDC storage, issuer identity, billing requests and recapturing refreshed tokens. ProjectManager implements these contracts directly with Node's standard library and adds its existing UI/API security model; it does not install or execute the Python tool.

Pinned MIT source and license are retained in [upstream/grok-swap](upstream/grok-swap/REFERENCE.md) for recovery and comparison if Grok changes its private protocol. These endpoints are version-dependent, so unrecognized data fails to unknown usage. Automated tests use temporary credential files and injected HTTP fixtures; they do not change live accounts or contact the provider.
