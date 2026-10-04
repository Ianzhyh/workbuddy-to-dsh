"""Characterise the `$wbEncrypted` envelope format WITHOUT printing ciphertext.

Emits only structural facts: segment count, per-segment lengths, whether each
segment is base64/base64url, and the decoded JOSE/JWE header when present (the
header carries only algorithm identifiers, which are not secret).
"""
import base64
import json
import re
import sys
from pathlib import Path


def b64_stats(seg):
    if not seg:
        return "empty"
    urlsafe = bool(re.fullmatch(r"[A-Za-z0-9_\-]*", seg))
    std = bool(re.fullmatch(r"[A-Za-z0-9+/=]*", seg))
    kind = "base64url" if urlsafe and not std else ("base64" if std else "unknown")
    try:
        raw = base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))
        dec = len(raw)
    except Exception:  # noqa: BLE001
        dec = -1
    return f"{kind}, decoded={dec}B"


def main():
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    for field in ("accessToken", "refreshToken"):
        node = data.get("auth", {}).get(field)
        print(f"### auth.{field}")
        if not isinstance(node, dict):
            print(f"  plain {type(node).__name__}, len={len(str(node))}")
            continue
        print(f"  wrapper keys = {sorted(node.keys())}")
        env = node.get("envelope")
        if not isinstance(env, str):
            print(f"  envelope type = {type(env).__name__}")
            continue
        print(f"  envelope length = {len(env)}")
        segs = env.split(".")
        print(f"  dot-separated segments = {len(segs)}")
        for i, seg in enumerate(segs):
            print(f"    seg[{i}] len={len(seg):5d}  {b64_stats(seg)}")
        if len(segs) >= 2 and len(segs) <= 6:
            try:
                header = base64.urlsafe_b64decode(segs[0] + "=" * (-len(segs[0]) % 4))
                print(f"  JOSE header = {header.decode('utf-8', 'replace')}")
            except Exception as exc:  # noqa: BLE001
                print(f"  header decode failed: {exc}")
        else:
            head = env[:16]
            printable = all(32 <= ord(c) < 127 for c in head)
            print(f"  leading bytes printable = {printable}  first8hex = {env[:8].encode().hex()}")
        print()


if __name__ == "__main__":
    main()
