# WorkBuddy 本地 API 桥 —— 容器形态。
#
# 适用：CODEBUDDY_API_KEY 的网关模式（上游 key 由外部注入，env 传入）。
# 桌面凭据模式需要 WorkBuddy.exe 在本机取 AtRest 密钥，容器里没有该二进制 ——
# 那种用法请保持「本机 + 启动.cmd」形态（见 README）。
#
# 构建：docker build -t workbuddy-bridge .
# 运行：docker run -d -p 8790:8790 -p 8792:8792 \
#         -e CODEBUDDY_API_KEY=<你的 key> \
#         --name workbuddy-bridge workbuddy-bridge
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# 源码（本仓库零运行时依赖，无需 npm install）
COPY package.json ./
COPY bridge/ ./bridge/
COPY config.mjs ./
COPY lib/ ./lib/
COPY dashboard/ ./dashboard/

# 运行期数据（账本 / 令牌 / 任务）放在卷里，重建容器不丢。
ENV WORKBUDDY_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node

EXPOSE 8790 8792

# /health 与其它端点都要求本地令牌。容器里没有桌面端可以读，必须由外部
# 通过 `-e WORKBUDDY_LOCAL_TOKEN=...` 注入；没注入就如实 unhealthy，
# 不再用空 Bearer 假装健康（旧写法在随机令牌下必然 401）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test -n "$WORKBUDDY_LOCAL_TOKEN" && wget -qO- --header="Authorization: Bearer $WORKBUDDY_LOCAL_TOKEN" http://127.0.0.1:8790/ >/dev/null 2>&1 || exit 1

CMD ["node", "dashboard/server.mjs"]
