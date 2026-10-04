"""把 .credentials.yaml 的 version 字段恢复为数字，撤销一次错误推断。

背景：本机存在两套 dsh 运行时——

  * E:\\harness\\resources\\runtime       DSH Desktop，desktopVersion 0.2.0-rc.2（实际在用）
  * C:\\Users\\demo\\DeepSeek-Harness\\runtime   0.1.0-rc.6（旧安装）

曾按旧版（0.1.0-rc.6）的报错提示把 `version: 1` 改成字符串 `version: "1"`。
但该文件是 0.2.0-rc.2 自己写的，数字形式才是它认可的形式，因此这里恢复原状。

判定依据：文件的 mtime（2026-10-02 20:06）晚于 DSH Desktop 安装时间（2026-09-29），
说明它是当前版本写入的。

用法：python tools/dev/restore-credentials-version.py [路径]
"""
import datetime
import shutil
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\demo\.dsh\.credentials.yaml")

if not path.exists():
    sys.exit(f"文件不存在：{path}")

text = path.read_text(encoding="utf-8")

if text.startswith("version: 1"):
    print("version 已是数字，无需恢复")
    sys.exit(0)

if not (text.startswith('version: "1"') or text.startswith("version: '1'")):
    sys.exit("首行不是预期的 version 字段，拒绝猜测，请人工检查")

backup = path.with_name(
    f"{path.name}.bak-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
)
shutil.copy2(path, backup)

fixed = text.replace('version: "1"', "version: 1", 1).replace("version: '1'", "version: 1", 1)
path.write_text(fixed, encoding="utf-8", newline="")

print(f"备份   : {backup.name}")
print(f"首行   : {fixed.splitlines()[0]}")
print(f"大小   : {len(fixed)} 字节")
print("已恢复为原始格式。")
