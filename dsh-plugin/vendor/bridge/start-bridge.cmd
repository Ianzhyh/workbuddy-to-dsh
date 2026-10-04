@echo off
rem 独立启动桥（不开控制台）。
rem 配置来自：环境变量 > .env > 内置默认值，详见 .env.example。
rem 登录文件与客户端路径由 config.mjs 统一解析，不再在此硬编码。
setlocal

set "NODE_EXE=E:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

cd /d "%~dp0.."
"%NODE_EXE%" bridge\launch.mjs
