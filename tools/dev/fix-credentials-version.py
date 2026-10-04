"""把 .credentials.yaml 的 version 字段修正为字符串。

dsh 的 credentials-local 插件要求该字段是字符串，而旧格式文档里写的是数字
（`version: 1`）。数字会让 profile 在插件初始化阶段直接抛 TypeError：

    credentials-local: the value for "version" in .credentials.yaml must be a string

注意 dump-config 不会暴露这个问题——它只做静态组合，不做插件初始化。

用法：python tools/dev/fix-credentials-version.py [路径]
"""
import datetime
import shutil
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\demo\.dsh\.credentials.yaml")

if not path.exists():
    sys.exit(f"文件不存在：{path}")

text = path.read_text(encoding="utf-8")

if text.startswith('version: "1"') or text.startswith("version: '1'"):
    print("version 已是字符串，无需修改")
    sys.exit(0)

if not text.startswith("version: 1"):
    sys.exit("首行不是预期的 `version: 1`，拒绝猜测，请人工检查")

backup = path.with_name(
    f"{path.name}.bak-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
)
shutil.copy2(path, backup)

fixed = text.replace("version: 1", 'version: "1"', 1)
path.write_text(fixed, encoding="utf-8", newline="")

print(f"备份   : {backup.name}")
print(f"首行   : {fixed.splitlines()[0]}")
print(f"大小   : {len(fixed)} 字节")
print("已修正。")
