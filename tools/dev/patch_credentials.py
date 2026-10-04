"""Insert the local bridge placeholder credential into $DSH_HOME/.credentials.yaml.

Plain text surgery on purpose: the file also holds a `records:` tree that a YAML
round-trip would reflow. A timestamped backup is written first, and the script
is idempotent and prints nothing about existing values.
"""
import shutil
import sys
from datetime import datetime
from pathlib import Path

REF_NAME = "WORKBUDDY_BRIDGE_KEY"
REF_VALUE = "wb-local-bridge"

path = Path(r"C:\Users\demo\.dsh\.credentials.yaml")
if not path.exists():
    sys.exit(f"missing: {path}")

text = path.read_text(encoding="utf-8")

if REF_NAME in text:
    print(f"already present: {REF_NAME} (no change)")
    sys.exit(0)

anchor = "\nrecords:"
if anchor not in text:
    sys.exit("anchor 'records:' not found; refusing to guess")

backup = path.with_name(
    f"{path.name}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
)
shutil.copy2(path, backup)

text = text.replace(anchor, f"\n  {REF_NAME}: {REF_VALUE}{anchor}", 1)
path.write_text(text, encoding="utf-8", newline="")

print(f"backup written : {backup.name}")
print(f"inserted       : {REF_NAME}")
print(f"refs count     : {sum(1 for l in text.splitlines() if l.startswith('  ') and ': ' in l and not l.startswith('    '))}")
