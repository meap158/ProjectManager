"""Parse and write Grok Build ``auth.json`` without logging secrets."""

from __future__ import annotations

import base64
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from grok_swap.exceptions import GswapError

PREFERRED_ISSUERS = ("https://auth.x.ai", "https://accounts.x.ai")


@dataclass(frozen=True)
class AuthIdentity:
    email: str
    user_id: str
    team_id: str
    first_name: str
    principal_type: str
    auth_mode: str
    expires_at: str | None
    issuer_key: str
    tier: int | None
    access_token: str
    raw: dict[str, Any]

    @property
    def expired(self) -> bool:
        if not self.expires_at:
            return False
        try:
            exp = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
        except ValueError:
            return False
        return exp <= datetime.now(timezone.utc)


def load_auth(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GswapError(f"Could not read {path}: {exc}") from exc
    if not isinstance(data, dict) or not data:
        return None
    return data


def parse_identity(data: dict[str, Any]) -> AuthIdentity:
    issuer_key, entry = _pick_entry(data)
    if not isinstance(entry, dict):
        raise GswapError("Grok auth.json has no usable OIDC entry")
    email = str(entry.get("email") or "").strip()
    if not email:
        email = _first_email(data) or ""
    if not email:
        raise GswapError("Grok auth.json has no email — run: grok login")
    token = str(entry.get("key") or "")
    jwt_claims = _jwt_claims(token)
    tier = _as_int(entry.get("tier"))
    if tier is None:
        tier = _as_int(jwt_claims.get("tier"))
    return AuthIdentity(
        email=email,
        user_id=str(entry.get("user_id") or entry.get("principal_id") or jwt_claims.get("principal_id") or ""),
        team_id=str(entry.get("team_id") or jwt_claims.get("team_id") or ""),
        first_name=str(entry.get("first_name") or "").strip(),
        principal_type=str(entry.get("principal_type") or jwt_claims.get("principal_type") or ""),
        auth_mode=str(entry.get("auth_mode") or ""),
        expires_at=str(entry.get("expires_at") or "") or None,
        issuer_key=issuer_key,
        tier=tier,
        access_token=token,
        raw=data,
    )


def identity_from_path(path: Path) -> AuthIdentity | None:
    data = load_auth(path)
    if data is None:
        return None
    return parse_identity(data)


def write_auth(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, sort_keys=False) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=".auth.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def clear_auth(path: Path) -> None:
    if path.is_file():
        path.unlink()


def _pick_entry(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    for prefix in PREFERRED_ISSUERS:
        for key, value in data.items():
            if isinstance(value, dict) and str(key).startswith(prefix):
                return str(key), value
    for key, value in data.items():
        if isinstance(value, dict) and (value.get("email") or value.get("key")):
            return str(key), value
    raise GswapError("Grok auth.json has no OIDC session entry")


def _first_email(value: Any, depth: int = 0) -> str | None:
    if depth > 6:
        return None
    if isinstance(value, dict):
        for key in ("email", "emailAddress"):
            raw = value.get(key)
            if isinstance(raw, str) and "@" in raw:
                return raw.strip()
        for child in value.values():
            found = _first_email(child, depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _first_email(child, depth + 1)
            if found:
                return found
    return None


def _jwt_claims(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload + padding)
        data = json.loads(decoded)
    except (ValueError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None
