#!/usr/bin/env bash
# 一键启动控制台（macOS / Linux）。
# 桥由控制台的「启动桥服务」按钮管理，本脚本不重复启动。
set -euo pipefail

cd "$(dirname "$0")/.."

node dashboard/server.mjs
