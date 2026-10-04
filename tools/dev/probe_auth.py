"""Inspect the WorkBuddy desktop auth file structure WITHOUT printing secrets.

Only key names, value types, lengths and non-sensitive scalar values (URLs,
booleans, timestamps, enums) are emitted. Any string longer than 40 chars is
replaced by a length marker.
"""
import json
import sys
from pathlib import Path

SENSITIVE_HINT = ("token", "secret", "key", "jwt", "credential", "cookie", "session")


def redact(value):
    if isinstance(value, str):
        if len(value) > 40:
            return f"<str len={len(value)}>"
        low = value.lower()
        if any(h in low for h in ("eyj", "bearer ")):
            return f"<str len={len(value)}>"
        return value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return f"<list len={len(value)}>"
    if isinstance(value, dict):
        return "<dict>"
    return f"<{type(value).__name__}>"


def walk(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        print(f"{path}[]  (list, len={len(node)})")
        for i, item in enumerate(node[:3]):
            walk(item, f"{path}[{i}]")
    else:
        print(f"{path} = {redact(node)}")


def main():
    for name in sys.argv[1:]:
        p = Path(name)
        print(f"### {p.name}")
        if not p.exists():
            print("  <missing>")
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"  <parse error: {exc}>")
            continue
        walk(data)
        print()


if __name__ == "__main__":
    main()
