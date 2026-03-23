import re
from datetime import datetime, timezone


def utcnow_iso():
    return datetime.utcnow().isoformat()


def row_to_dict(row):
    if row is None:
        return None
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, 'keys'):
        return {key: row[key] for key in row.keys()}
    return dict(row)


def parse_iso_datetime(value):
    raw = str(value or '').strip()
    if not raw:
        return None
    normalized = raw.replace('Z', '+00:00')
    try:
        dt = datetime.fromisoformat(normalized)
    except Exception:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def invitation_is_expired(expires_at):
    dt = parse_iso_datetime(expires_at)
    if dt is None:
        return True
    return dt < datetime.utcnow()


def normalize_email(value):
    return str(value or '').strip().lower()


def parse_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ('1', 'true', 'yes', 'on'):
            return True
        if lowered in ('0', 'false', 'no', 'off'):
            return False
    return bool(default)


def parse_int(value, default_value, min_value=None, max_value=None):
    try:
        parsed = int(value)
    except Exception:
        parsed = int(default_value)
    if min_value is not None:
        parsed = max(min_value, parsed)
    if max_value is not None:
        parsed = min(max_value, parsed)
    return parsed


def parse_float(value, default_value, min_value=None, max_value=None):
    try:
        parsed = float(value)
    except Exception:
        parsed = float(default_value)
    if min_value is not None:
        parsed = max(float(min_value), parsed)
    if max_value is not None:
        parsed = min(float(max_value), parsed)
    return parsed


def normalize_document_category(value):
    category = str(value or '').strip()
    if not category:
        return ''
    category = re.sub(r'\s+', ' ', category)
    return category[:80]
