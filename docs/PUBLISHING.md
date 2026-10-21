# 发布镜像 · 运维手册

> 面向维护者：把本项目构建成多架构镜像并推到 Docker Hub，供部署机 `docker compose pull` 使用。
> 日常使用、部署、环境变量请看 [../README.md](../README.md)。
>
> 一键脚本：`./publish.sh`（唯一入口，两条路线用 `--proxy` 切换）
> 涉及服务：Docker Hub 仓库 `wyc6036/travelmap`

---

## 一、两条路线，先选一条

| 路线 | 触发方式 | 原理 | 适用场景 |
|---|---|---|---|
| **A 直连 buildx** | `./publish.sh <user> <tag>` | `docker buildx build --platform amd64,arm64 --push`，一次构建两架构并推 manifest list | 服务器 / 能直连 Docker Hub 的机器 |
| **B 守护进程 + 代理** | `./publish.sh <user> <tag> --proxy` | 分架构 `docker build` → `docker push` → `buildx imagetools create` 合成索引 | **Mac + 代理**，或 `registry-1.docker.io` 被污染时 |

**为什么 Mac 上必须走 B**：`docker buildx` 用 docker-container driver 时，buildkitd 跑在独立容器里，`--driver-opt env.HTTP_PROXY` 对它拉基础镜像**不生效**；buildkitd 解析 `auth.docker.io` 拿到被投毒的假 IP（`31.13.x` / `199.59.x` / `202.160.x`）→ `i/o timeout`。B 路线绕开 buildkit，让**守护进程**去拉、去推，只在最后合成索引时让 CLI 走 shell 代理。

---

## 二、一次性前置

### 共通
```bash
docker login          # 推送需要凭证
```

### 仅路线 A 额外检查
多架构构建通常 Docker Desktop 已内置 QEMU 模拟。若 buildx 报找不到平台：
```bash
docker buildx create --use
docker run --privileged --rm tonistiigi/binfmt --install all
```

### 仅路线 B 额外配置（Mac + 代理）

1. **Docker Desktop** → Settings → Resources → **Proxies** → Manual
   HTTP / HTTPS Proxy 都填 `http://127.0.0.1:7890` → **Apply & Restart**
   - ⚠️ 必须 `http://`。字段名叫 HTTPS Proxy 指的是「代理 HTTPS 目标流量」，填 `https://` 会对代理本身做 TLS 握手 → `EOF`。
2. **代理客户端**（Clash / Surge）：开启 **Allow LAN / 允许局域网** + 切 **全局模式**
   - Allow LAN 让代理监听 `0.0.0.0`，容器才能经 `host.docker.internal` 够到它。
3. 核对系统代理（应显示 `1` / `127.0.0.1` / `7890`）：
   ```bash
   scutil --proxy | grep -E 'HTTPSEnable|HTTPSProxy|HTTPSPort'
   ```
4. 自检容器能否经代理连上 Docker Hub，返回 `200` 即通：
   ```bash
   docker run --rm curlimages/curl -s -o /dev/null -w "%{http_code}\n" \
     -x http://host.docker.internal:7890 \
     "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/hello-world:pull"
   ```

---

## 三、推送（日常就这两行）

```bash
# 路线 A：直连
./publish.sh wyc6036 v4

# 路线 B：Mac 挂代理（第 3 参数可换代理端口，默认 7890）
./publish.sh wyc6036 v4 --proxy
```

脚本会依次完成：构建两架构 →（B 路线：分架构推送）→ 合成 `:v4` 与 `:latest` 的多架构 OCI 索引 → 打印验证命令。
`--proxy` 后可跟端口号（如 `--proxy 7891`），也可用环境变量 `PROXY_PORT=7891`。

### 手动执行路线 B（想逐步理解时）

```bash
cd /path/to/travelmap

# 1) 切回守护进程 builder（docker-container builder 拿不到代理，必须绕开）
docker buildx use default

# 2) 分架构构建（守护进程经代理拉 node:20-slim）
docker build --platform linux/amd64 -t wyc6036/travelmap:v4-amd64 .
docker build --platform linux/arm64 -t wyc6036/travelmap:v4-arm64 .

# 3) 推送两个架构（失败就重跑，push 会断点续传）
docker push wyc6036/travelmap:v4-amd64
docker push wyc6036/travelmap:v4-arm64

# 4) 让 CLI 也走代理，再合成多架构（关键：imagetools，不是 manifest create）
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1
docker buildx imagetools create -t wyc6036/travelmap:v4     wyc6036/travelmap:v4-amd64 wyc6036/travelmap:v4-arm64
docker buildx imagetools create -t wyc6036/travelmap:latest wyc6036/travelmap:v4-amd64 wyc6036/travelmap:v4-arm64
```

> 若 `docker build` 拉基础镜像仍超时，命令前加 `DOCKER_BUILDKIT=0` 强制走旧版守护进程构建。

---

## 四、验证

```bash
docker buildx imagetools inspect wyc6036/travelmap:v4
```

看到 `Platform: linux/amd64` 和 `Platform: linux/arm64` 两条 = 成功。
（`unknown/unknown` 条目是 buildkit 的 attestation manifest，正常无害。）

---

## 五、部署机拉取

```bash
docker compose pull
docker compose up -d        # 不要加 --build
```

`docker-compose.yml` 引用 `${DH_USER}/travelmap:latest`，多架构索引会自动匹配部署机架构，ARM / x86 都无需改配置。

---

## 六、清理中间 tag

路线 B 会产生 `v4-amd64` / `v4-arm64` 两个中间 tag，删掉不影响 `:v4` 与 `:latest`（索引按 digest 引用底层 blob）。

- **远程**：hub.docker.com → 仓库 → **Tags** → 删 `v4-amd64`、`v4-arm64`
- **本地**：
  ```bash
  docker rmi wyc6036/travelmap:v4-amd64 wyc6036/travelmap:v4-arm64
  docker buildx rm proxied 2>/dev/null
  ```

---

## 七、报错速查

| 报错特征 | 原因 | 处理 |
|---|---|---|
| `auth.docker.io i/o timeout`，IP 是 `31.13.x / 199.59.x / 202.160.x` | DNS 投毒、请求没走代理 | 查 Docker Desktop 代理（`http://`）、Allow LAN、全局模式 |
| `TLS connect to 127.0.0.1:7890: EOF` | 代理填成了 `https://` | 改成 `http://` |
| 容器 / 构建连不上代理 | Clash 没开 Allow LAN | 开 Allow LAN |
| `docker buildx --push` 一直超时 | buildkit 拿不到代理 | 改走路线 B（`--proxy`） |
| `docker manifest create ... is a manifest list` | 用了老命令 | 换 `docker buildx imagetools create` |
| `docker push` 中途 `timeout awaiting response headers` | 代理抖动 | 重跑 push，会续传 |
| `imagetools` / `manifest` 超时 | CLI 没走代理 | `export HTTPS_PROXY=...`（脚本已内置） |
| 拉 `moby/buildkit` 卡 500s+ | 全局模式 + 国内加速器互相绕路 | 清空 `registry-mirrors` 直连，或直接走路线 B（不用 buildx 容器） |
| `invalid value "127.0.0.1", expecting k=v` | `--driver-opt` 按逗号拆分 | 别在该参数里传带逗号的值 |

### 关于 `NODE_BASE`（国内污染退化方案）

Dockerfile 有可选构建参数 `ARG NODE_BASE=node:20-slim`（两处 `FROM ${NODE_BASE}`）。国内网络下 `node:20-slim` 经部分镜像代理会被错误地只返回单一架构，导致交叉架构构建出的 base 层错乱（异架构机启动报 `exec format error`）。

极端情况下可先用多架构代理（如 `docker.1ms.run`）按 digest 拉取**真实架构**的 node 镜像并打 tag（`node-amd64-real` / `node-arm64-real`），再传 `--build-arg NODE_BASE=node-arm64-real` 让构建离线使用正确基础镜像。正常网络不需要传。

---

## 附：代理分工（最容易踩的坑）

- `docker push` / `docker pull` / `docker build` → 走**守护进程**代理（Docker Desktop 设置里那份）
- `docker buildx imagetools` / `docker manifest` / `docker login` → **CLI 直连 registry**，不吃守护进程代理，必须靠 shell 的 `export HTTPS_PROXY=...`
- `docker buildx` 的 docker-container builder → **两条路都不吃**，所以 Mac 上要换 driver（路线 B）

理解了这三条，前面所有 `i/o timeout` 都能对上号。
