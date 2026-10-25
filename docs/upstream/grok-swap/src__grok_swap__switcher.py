"""Snapshot, restore, and isolate Grok Build logins."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from grok_swap.auth import (
    AuthIdentity,
    clear_auth,
    identity_from_path,
    load_auth,
    parse_identity,
    write_auth,
)
from grok_swap.exceptions import GswapError
from grok_swap import paths
from grok_swap.store import AccountRecord, AccountStore, now_iso
from grok_swap.usage import UsageSnapshot, countdown, fetch_usage

SYMLINK_FROM_GROK = (
    "config.toml",
    "skills",
    "plugins",
    "installed-plugins",
    "bundled",
    "docs",
    "completions",
)


class GrokSwitcher:
    def __init__(
        self,
        grok_home: Path | None = None,
        store: AccountStore | None = None,
    ) -> None:
        self.grok_home = grok_home or paths.grok_home()
        self.auth_path = self.grok_home / "auth.json"
        self.store = store or AccountStore()

    def live_identity(self) -> AuthIdentity | None:
        return identity_from_path(self.auth_path)

    def add(self, slot: int | None = None, alias: str | None = None) -> AccountRecord:
        identity = self.live_identity()
        if identity is None:
            raise GswapError("No live Grok login. Run: grok login")
        data = load_auth(self.auth_path)
        if data is None:
            raise GswapError("No live Grok login. Run: grok login")
        state = self.store.load()
        existing = self.store.find_by_identity(state, identity.email, identity.user_id)
        if existing and slot is not None and slot != existing.slot:
            raise GswapError(
                f"{identity.email} is already stored in slot {existing.slot}"
            )
        target_slot = existing.slot if existing else (slot or self.store.next_slot(state))
        if slot is not None and not existing:
            if slot in state.accounts:
                raise GswapError(f"Slot {slot} already holds {state.accounts[slot].email}")
            target_slot = slot
        record = existing or AccountRecord(slot=target_slot, email=identity.email)
        record.email = identity.email
        record.user_id = identity.user_id
        record.team_id = identity.team_id
        record.first_name = identity.first_name
        record.expires_at = identity.expires_at
        record.tier = identity.tier
        record.auth_mode = identity.auth_mode
        record.principal_type = identity.principal_type
        record.updated_at = now_iso()
        if not record.added_at:
            record.added_at = record.updated_at
        if alias:
            record.alias = _validate_alias(state, alias, skip_slot=target_slot)
        self.store.write_account_auth(target_slot, data)
        state.accounts[target_slot] = record
        state.active_slot = target_slot
        self.store.save(state)
        return record

    def remove(self, target: str) -> AccountRecord:
        state = self.store.load()
        record = self.store.resolve(state, target)
        self.store.delete_account(record.slot)
        del state.accounts[record.slot]
        if state.active_slot == record.slot:
            live = self.live_identity()
            if live and live.email.lower() == record.email.lower():
                state.active_slot = None
            else:
                state.active_slot = None
        self.store.save(state)
        return record

    def set_disabled(self, target: str, disabled: bool) -> AccountRecord:
        state = self.store.load()
        record = self.store.resolve(state, target)
        record.disabled = disabled
        state.accounts[record.slot] = record
        self.store.save(state)
        return record

    def set_alias(self, target: str, alias: str) -> AccountRecord:
        state = self.store.load()
        record = self.store.resolve(state, target)
        record.alias = _validate_alias(state, alias, skip_slot=record.slot)
        state.accounts[record.slot] = record
        self.store.save(state)
        return record

    def unset_alias(self, target: str) -> AccountRecord:
        state = self.store.load()
        record = self.store.resolve(state, target)
        record.alias = ""
        state.accounts[record.slot] = record
        self.store.save(state)
        return record

    def snapshot_live_if_managed(self, state=None):
        """Write the live auth.json back into its managed slot before replacing it."""
        state = state or self.store.load()
        identity = self.live_identity()
        if identity is None:
            return None
        data = load_auth(self.auth_path)
        if data is None:
            return None
        existing = self.store.find_by_identity(state, identity.email, identity.user_id)
        if existing is None:
            return identity
        existing.email = identity.email
        existing.user_id = identity.user_id
        existing.team_id = identity.team_id
        existing.first_name = identity.first_name
        existing.expires_at = identity.expires_at
        existing.tier = identity.tier
        existing.auth_mode = identity.auth_mode
        existing.principal_type = identity.principal_type
        existing.updated_at = now_iso()
        self.store.write_account_auth(existing.slot, data)
        state.accounts[existing.slot] = existing
        self.store.save(state)
        return identity

    def switch_to(self, target: str, force: bool = False) -> dict[str, Any]:
        state = self.store.load()
        record = self.store.resolve(state, target)
        if record.disabled and not force:
            raise GswapError(f"Account {record.email} is disabled — gswap enable {record.slot}")
        live = self.live_identity()
        if live and live.user_id and live.user_id == record.user_id:
            state.active_slot = record.slot
            self.store.save(state)
            return {
                "switched": False,
                "reason": "already-active",
                "account": _record_public(record, active=True),
            }
        if live:
            managed = self.store.find_by_identity(state, live.email, live.user_id)
            if managed is None and not force:
                raise GswapError(
                    f"Live login {live.email} is not in the roster. "
                    "Run gswap add first, or pass --force to overwrite it."
                )
            if managed is not None:
                self.snapshot_live_if_managed(state)
                state = self.store.load()
                record = state.accounts[record.slot]
        stored = self.store.read_account_auth(record.slot)
        write_auth(self.auth_path, stored)
        state.active_slot = record.slot
        restored = parse_identity(stored)
        record.email = restored.email
        record.user_id = restored.user_id
        record.expires_at = restored.expires_at
        record.updated_at = now_iso()
        state.accounts[record.slot] = record
        self.store.save(state)
        return {
            "switched": True,
            "from": live.email if live else None,
            "account": _record_public(record, active=True),
            "restartHint": "Restart running grok sessions so they pick up the new login.",
        }

    def switch_next(self) -> dict[str, Any]:
        state = self.store.load()
        enabled = [s for s, rec in sorted(state.accounts.items()) if not rec.disabled]
        if not enabled:
            raise GswapError("No managed accounts. Run: gswap add")
        current = state.active_slot
        if current in enabled:
            idx = enabled.index(current)
            nxt = enabled[(idx + 1) % len(enabled)]
        else:
            nxt = enabled[0]
        return self.switch_to(str(nxt))

    def status_payload(self) -> dict[str, Any]:
        state = self.store.load()
        live = self.live_identity()
        active = None
        if live:
            match = self.store.find_by_identity(state, live.email, live.user_id)
            if match:
                active = _record_public(match, active=True)
                state.active_slot = match.slot
                self.store.save(state)
        usage = None
        if live and live.access_token:
            usage = fetch_usage(live.access_token).as_dict()
        return {
            "schemaVersion": 1,
            "live": None
            if live is None
            else {
                "email": live.email,
                "userId": live.user_id,
                "teamId": live.team_id,
                "firstName": live.first_name,
                "expiresAt": live.expires_at,
                "expired": live.expired,
                "tier": live.tier,
                "authMode": live.auth_mode,
                "managed": active is not None,
            },
            "active": active,
            "totalManagedAccounts": len(state.accounts),
            "usage": usage,
            "grokHome": str(self.grok_home),
        }

    def list_payload(self, fetch: bool = True) -> dict[str, Any]:
        state = self.store.load()
        live = self.live_identity()
        active_slot = None
        if live:
            match = self.store.find_by_identity(state, live.email, live.user_id)
            if match:
                active_slot = match.slot
        records = [state.accounts[slot] for slot in sorted(state.accounts)]
        usage_by_slot: dict[int, UsageSnapshot] = {}
        if fetch and records:
            tokens: dict[int, str] = {}
            for record in records:
                try:
                    ident = parse_identity(self.store.read_account_auth(record.slot))
                    tokens[record.slot] = ident.access_token
                except GswapError:
                    continue
            with ThreadPoolExecutor(max_workers=min(8, max(1, len(tokens)))) as pool:
                futures = {slot: pool.submit(fetch_usage, token) for slot, token in tokens.items()}
                for slot, future in futures.items():
                    usage_by_slot[slot] = future.result()
        accounts = []
        for record in records:
            usage = usage_by_slot.get(record.slot)
            accounts.append(
                {
                    **_record_public(record, active=record.slot == active_slot),
                    "usage": usage.as_dict() if usage else None,
                }
            )
        return {
            "schemaVersion": 1,
            "activeSlot": active_slot,
            "accounts": accounts,
            "grokHome": str(self.grok_home),
        }

    def materialize(self, target: str, dest: Path) -> Path:
        state = self.store.load()
        record = self.store.resolve(state, target)
        dest = dest.expanduser().resolve()
        dest.mkdir(parents=True, exist_ok=True)
        dest.chmod(0o700)
        write_auth(dest / "auth.json", self.store.read_account_auth(record.slot))
        for name in SYMLINK_FROM_GROK:
            src = self.grok_home / name
            target_path = dest / name
            if target_path.exists() or target_path.is_symlink():
                continue
            if src.exists():
                try:
                    os.symlink(src, target_path)
                except OSError:
                    if src.is_file():
                        shutil.copy2(src, target_path)
        (dest / "sessions").mkdir(exist_ok=True)
        return dest

    def run(self, target: str, grok_args: list[str]) -> None:
        dest = paths.run_home(self.store.resolve(self.store.load(), target).slot)
        self.materialize(target, dest)
        binary = shutil.which("grok")
        if not binary:
            raise GswapError("grok is not on PATH")
        env = os.environ.copy()
        env["GROK_HOME"] = str(dest)
        os.execvpe(binary, [binary, *grok_args], env)

    def env_lines(self, target: str) -> str:
        dest = paths.run_home(self.store.resolve(self.store.load(), target).slot)
        self.materialize(target, dest)
        return f"export GROK_HOME={_shell_single(str(dest))}\n"

    def doctor(self) -> dict[str, Any]:
        live = self.live_identity()
        grok_bin = shutil.which("grok")
        issues: list[str] = []
        if grok_bin is None:
            issues.append("grok binary not found on PATH")
        if live is None:
            issues.append(f"no live login at {self.auth_path}")
        elif live.expired:
            issues.append(f"live token expired at {live.expires_at} — run grok login, then gswap add")
        if self.auth_path.is_file():
            mode = stat.S_IMODE(self.auth_path.stat().st_mode)
            if mode & 0o077:
                issues.append(f"{self.auth_path} is mode {mode:o}; expected 0600")
        usage = None
        if live and live.access_token:
            snap = fetch_usage(live.access_token)
            usage = snap.as_dict()
            if snap.error:
                issues.append(f"billing probe failed: {snap.error}")
        state = self.store.load()
        missing_creds = [
            rec.email for rec in state.accounts.values() if not self.store.auth_path(rec.slot).is_file()
        ]
        if missing_creds:
            issues.append("missing stored auth.json for: " + ", ".join(missing_creds))
        return {
            "ok": not issues,
            "grokBinary": grok_bin,
            "grokHome": str(self.grok_home),
            "authPath": str(self.auth_path),
            "store": str(self.store.root),
            "liveEmail": live.email if live else None,
            "managedAccounts": len(state.accounts),
            "usage": usage,
            "issues": issues,
        }

    def purge(self) -> None:
        root = self.store.root
        if root.exists():
            shutil.rmtree(root)


def format_list(payload: dict[str, Any]) -> str:
    from grok_swap.printer import bold, cyan, dim, green, yellow

    accounts = payload.get("accounts") or []
    if not accounts:
        return dim("No managed accounts. Log in with grok login, then: gswap add")
    lines = [bold("Accounts:")]
    for account in accounts:
        marker = green("*") if account.get("active") else " "
        alias = f" [{account['alias']}]" if account.get("alias") else ""
        disabled = yellow(" (disabled)") if account.get("disabled") else ""
        name = account.get("firstName") or ""
        suffix = f" {dim(name)}" if name else ""
        lines.append(f"  {marker} {account['slot']}: {cyan(account['email'])}{alias}{suffix}{disabled}")
        usage = account.get("usage") or {}
        if usage.get("error"):
            lines.append(f"     └ {dim('usage: ' + usage['error'])}")
        elif usage.get("percent") is not None:
            plan = usage.get("plan") or ""
            period = usage.get("periodType") or "Credits"
            reset = countdown(usage.get("resetsAt"))
            reset_bit = f"  resets in {reset}" if reset else ""
            plan_bit = f"  {plan}" if plan else ""
            lines.append(
                f"     └ {period}: {usage['percent']:.0f}%{reset_bit}{plan_bit}"
            )
        if account.get("expiresAt"):
            expired = " expired" if account.get("expired") else ""
            lines.append(f"     └ token expires {account['expiresAt']}{expired}")
    return "\n".join(lines)


def format_status(payload: dict[str, Any]) -> str:
    from grok_swap.printer import bold, cyan, dim, green, yellow

    live = payload.get("live")
    if not live:
        return yellow("No live Grok login.") + " Run: grok login"
    lines = [
        f"{bold('gswap')}  {cyan(live['email'])}"
        + (f"  {dim(live['firstName'])}" if live.get("firstName") else "")
    ]
    if live.get("managed"):
        lines.append(green("managed") + f"  slot {payload['active']['slot']}")
    else:
        lines.append(yellow("not in roster") + " — run: gswap add")
    if live.get("tier") is not None:
        lines.append(f"tier {live['tier']}")
    usage = payload.get("usage") or {}
    if usage.get("plan"):
        lines.append(usage["plan"])
    if usage.get("percent") is not None:
        period = usage.get("periodType") or "Credits"
        reset = countdown(usage.get("resetsAt"))
        extra = f"  resets in {reset}" if reset else ""
        lines.append(f"{period}: {usage['percent']:.0f}%{extra}")
    elif usage.get("error"):
        lines.append(dim(f"usage unavailable ({usage['error']})"))
    if live.get("expired"):
        lines.append(yellow(f"token expired at {live.get('expiresAt')} — grok login, then gswap add"))
    lines.append(dim(str(payload.get("grokHome"))))
    return "\n".join(lines)


def running_grok_hint() -> str | None:
    try:
        result = subprocess.run(
            ["pgrep", "-lf", "grok"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = [
        line
        for line in (result.stdout or "").splitlines()
        if "grok" in line and "gswap" not in line and sys.executable not in line
    ]
    if not lines:
        return None
    return f"{len(lines)} grok process(es) still running — restart them to pick up the new account."


def _record_public(record: AccountRecord, active: bool) -> dict[str, Any]:
    expired = False
    if record.expires_at:
        try:
            from datetime import datetime, timezone

            expired = (
                datetime.fromisoformat(record.expires_at.replace("Z", "+00:00"))
                <= datetime.now(timezone.utc)
            )
        except ValueError:
            expired = False
    return {
        "slot": record.slot,
        "email": record.email,
        "alias": record.alias,
        "userId": record.user_id,
        "teamId": record.team_id,
        "firstName": record.first_name,
        "disabled": record.disabled,
        "active": active,
        "expiresAt": record.expires_at,
        "expired": expired,
        "tier": record.tier,
        "authMode": record.auth_mode,
    }


def _validate_alias(state, alias: str, skip_slot: int) -> str:
    name = alias.strip()
    if not name or name.isdigit():
        raise GswapError("Alias must be non-numeric")
    for rec in state.accounts.values():
        if rec.slot != skip_slot and rec.alias.lower() == name.lower():
            raise GswapError(f"Alias {name!r} already used by slot {rec.slot}")
    return name


def _shell_single(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"
