"""Filesystem locations for Grok Build and gswap state."""

from __future__ import annotations

import os
from pathlib import Path


def grok_home() -> Path:
    override = os.environ.get("GROK_HOME") or os.environ.get("GROK_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".grok"


def grok_auth_path() -> Path:
    return grok_home() / "auth.json"


def store_root() -> Path:
    override = os.environ.get("GSWAP_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".grok-swap"


def state_path() -> Path:
    return store_root() / "state.json"


def account_dir(slot: int) -> Path:
    return store_root() / "accounts" / str(slot)


def account_auth_path(slot: int) -> Path:
    return account_dir(slot) / "auth.json"


def run_home(slot: int) -> Path:
    return store_root() / "homes" / str(slot)
