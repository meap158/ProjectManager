"""Best-effort SuperGrok credit usage via the Grok CLI billing proxy."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
TIMEOUT_SECONDS = 6


@dataclass(frozen=True)
class UsageSnapshot:
    percent: float | None
    period_type: str
    resets_at: str | None
    plan: str | None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "percent": self.percent,
            "periodType": self.period_type,
            "resetsAt": self.resets_at,
            "plan": self.plan,
            "error": self.error,
        }


def fetch_usage(access_token: str) -> UsageSnapshot:
    if not access_token:
        return UsageSnapshot(None, "", None, None, "no access token")
    try:
        billing = _get_json(BILLING_URL, access_token)
    except Exception as exc:
        return UsageSnapshot(None, "", None, None, _short_error(exc))
    config = billing.get("config") if isinstance(billing, dict) else None
    if not isinstance(config, dict):
        return UsageSnapshot(None, "", None, None, "unexpected billing payload")
    percent = config.get("creditUsagePercent")
    if not isinstance(percent, (int, float)):
        percent = None
    period = config.get("currentPeriod") if isinstance(config.get("currentPeriod"), dict) else {}
    period_type = str(period.get("type") or "")
    resets_at = period.get("end") or config.get("billingPeriodEnd")
    plan = None
    try:
        settings = _get_json(SETTINGS_URL, access_token)
        raw_plan = settings.get("subscription_tier_display")
        if isinstance(raw_plan, str) and raw_plan.strip():
            plan = raw_plan.strip()
    except Exception:
        plan = None
    return UsageSnapshot(
        percent=float(percent) if percent is not None else None,
        period_type=_human_period(period_type),
        resets_at=str(resets_at) if resets_at else None,
        plan=plan,
    )


def countdown(resets_at: str | None) -> str:
    if not resets_at:
        return ""
    try:
        end = datetime.fromisoformat(str(resets_at).replace("Z", "+00:00"))
    except ValueError:
        return ""
    now = datetime.now(timezone.utc)
    delta = end - now
    seconds = int(delta.total_seconds())
    if seconds <= 0:
        return "now"
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def _get_json(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "x-xai-token-auth": "xai-grok-cli",
            "Accept": "application/json",
            "User-Agent": "gswap/0.1",
        },
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(request, context=ctx, timeout=TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("non-object JSON")
    return payload


def _human_period(raw: str) -> str:
    mapping = {
        "USAGE_PERIOD_TYPE_WEEKLY": "Weekly",
        "USAGE_PERIOD_TYPE_MONTHLY": "Monthly",
        "USAGE_PERIOD_TYPE_DAILY": "Daily",
    }
    return mapping.get(raw, raw.replace("USAGE_PERIOD_TYPE_", "").title() if raw else "")


def _short_error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    text = str(exc).strip() or type(exc).__name__
    # Never echo bearer tokens if an exception interpolates headers.
    if "Bearer " in text or "eyJ" in text:
        return type(exc).__name__
    return text[:80]
