# ============================================================
# cyberboss Docker build for Render deployment
# 云端部署用：Node runtime + Claude Code 原生安装器 + cyberboss
# ============================================================

FROM node:22-bookworm-slim

# curl 用于装 Claude Code 原生安装器；git 用于装 package.json 里那两个 github: 依赖；
# imagemagick 用于把静态图表情包转成 GIF（Linux 上没有 macOS 的 sips）
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git imagemagick \
    && rm -rf /var/lib/apt/lists/*

# 装 Claude Code CLI（原生安装器，不依赖 npm 包）
RUN curl -fsSL https://claude.ai/install.sh | bash -s stable
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制项目文件
COPY . .
RUN cp cyberboss-workspace-main/mcp-seed.json cyberboss-workspace-main/.mcp.json

# 持久化挂载点：cyberboss 状态（账号/记忆/日记/线程）+ Claude Code 登录凭证
# HOME 指到这里，claude 和 cyberboss 的默认存储路径都会落在这个持久化磁盘上
ENV HOME=/data
ENV CYBERBOSS_HOME=/app
VOLUME ["/data"]

# diary-server runs in the background (read-only diary HTTP API for Tidal_Echo's
# web PWA); if it crashes it must not take the WeChat bridge down with it.
CMD ["sh", "-c", "npm run diary:start & npm run shared:start"]
