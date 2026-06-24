"""Unified message origin matching helpers.

Configured identifiers support:
- full AstrBot unified_msg_origin (UMO), exact match;
- plain QQ group number;
- plain QQ user number.
"""

from __future__ import annotations

import re

_QQ_NUMBER_RE = re.compile(r"\d{5,12}")


def normalize_identifier(value: object) -> str:
    return str(value or "").strip()


def extract_numeric_identifiers(umo: str) -> set[str]:
    text = normalize_identifier(umo)
    if not text:
        return set()
    return set(_QQ_NUMBER_RE.findall(text))


def matches_umo_identifier(umo: str, configured_values: list[str] | tuple[str, ...] | set[str]) -> bool:
    normalized_umo = normalize_identifier(umo)
    if not normalized_umo:
        return False
    configured = {normalize_identifier(item) for item in configured_values if normalize_identifier(item)}
    if not configured:
        return False
    if normalized_umo in configured:
        return True
    return bool(extract_numeric_identifiers(normalized_umo) & configured)
