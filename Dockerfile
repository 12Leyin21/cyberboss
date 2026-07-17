# ============================================================
# cyberboss Docker build for Render deployment
# 云端部署用：Node runtime + Claude Code 原生安装器 + cyberboss
# ============================================================

FROM node:22-bookworm-slim

# curl 用于装 Claude Code 原生安装器；git 用于装 package.json 里那两个 github: 依赖；
# imagemagick 用于把静态图表情包转成 GIF（Linux 上没有 macOS 的 sips）；
# python3/pip 用于同容器内跑 Tidal 中继（FastAPI）
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git imagemagick python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 装 Claude Code CLI（原生安装器，不依赖 npm 包）
RUN curl -fsSL https://claude.ai/install.sh | bash -s stable
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 中继的 Python 依赖
COPY relay/requirements.txt relay/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r relay/requirements.txt

# 复制项目文件
COPY . .
RUN cp cyberboss-workspace-main/mcp-seed.json cyberboss-workspace-main/.mcp.json

# 持久化挂载点：cyberboss 状态（账号/记忆/日记/线程）+ Claude Code 登录凭证
# HOME 指到这里，claude 和 cyberboss 的默认存储路径都会落在这个持久化磁盘上
ENV HOME=/data
ENV CYBERBOSS_HOME=/app
VOLUME ["/data"]

# 双进程启动：中继（有 PORT+RELAY_SECRET 时启动）+ cyberboss 大脑
CMD ["bash", "./scripts/start-with-relay.sh"]
