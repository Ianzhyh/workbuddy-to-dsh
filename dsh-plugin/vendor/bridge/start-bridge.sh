#!/usr/bin/env bash
# 独立启动桥（不开控制台），macOS / Linux 用。
# 配置来自：环境变量 > .env > 内置默认值，详见 .env.example。
set -euo pipefail

cd "$(dirname "$0")/.."
exec node bridge/launch.mjs
