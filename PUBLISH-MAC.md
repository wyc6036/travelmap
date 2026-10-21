# Docker Hub 多架构镜像推送 · 执行手册（Mac + 代理）

> 本手册对应本项目在 **macOS + 代理** 环境下的 Docker Hub 推送流程。
> - 一键脚本：`publish-mac.sh`（Mac 专用，绕开 buildkit）
> - 直连服务器仍用原 `publish.sh`（`buildx --push`，更简洁）
>
> 背景：在 Mac + 代理环境下，`docker buildx build --push` 会失败——docker-container builder 的 buildkitd 拿不到代理（`--driver-opt env.HTTP_PROXY` 对它的镜像拉取不生效），buildkitd 解析 `auth.docker.io` 时拿到被投毒的假 IP → `i/o timeout`。因此本流程绕开 buildkit，全程走「守护进程」。

---

## 一、一次性前置配置（第一次才做）

1. **Docker Desktop** → Settings → Resources → **Proxies**
   → 选 **Manual** → HTTP Proxy、HTTPS Proxy **都填** `http://127.0.0.1:7890`
   → **Apply & Restart**
   - ⚠️ 必须是 `http://`，填 `https://` 会对代理本身做 TLS 握手 → `EOF`
2. **代理客户端**（Clash/Surge 等）：打开「**Allow LAN / 允许局域网**」+ 切「**全局模式**」
   - Allow LAN 让代理监听 `0.0.0.0`，容器才能经 `host.docker.internal` 够到它
3. 终端核对系统代理（应显示 `1` / `127.0.0.1` / `7890`）：
   ```bash
   scutil --proxy | grep -E 'HTTPSEnable|HTTPSProxy|HTTPSPort'
   ```
4. 登录 Docker Hub：
   ```bash
   docker login
   ```
5. （可选）自检容器能否经代理连上 Docker Hub，返回 `200` 即通：
   ```bash
   docker run --rm curlimages/curl -s -o /dev/null -w "%{http_code}\n" \
     -x http://host.docker.internal:7890 \
     "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/hello-world:pull"
   ```

---

## 二、每次推送（两种方式，选一个）

### 方式 A：一键脚本（推荐）
```bash
cd /path/to/travelmap
./publish-mac.sh wyc6036 v3        # 第 3 参数可传代理端口，默认 7890
```

### 方式 B：手动命令（理解每一步）
```bash
cd /path/to/travelmap

# 1) 切回守护进程 builder（buildx 的 docker-container 拿不到代理，必须绕开）
docker buildx use default

# 2) 分架构构建（守护进程经代理拉 node:20-slim）
docker build --platform linux/amd64 -t wyc6036/travelmap:v3-amd64 .
docker build --platform linux/arm64 -t wyc6036/travelmap:v3-arm64 .

# 3) 推送两个架构（守护进程代理；失败就重跑，会续传）
docker push wyc6036/travelmap:v3-amd64
docker push wyc6036/travelmap:v3-arm64

# 4) 让 CLI 也走代理，再合成多架构（关键：imagetools，不是 manifest create）
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1
docker buildx imagetools create -t wyc6036/travelmap:v3     wyc6036/travelmap:v3-amd64 wyc6036/travelmap:v3-arm64
docker buildx imagetools create -t wyc6036/travelmap:latest wyc6036/travelmap:v3-amd64 wyc6036/travelmap:v3-arm64
```

> 若 `docker build` 拉基础镜像仍超时，命令前加 `DOCKER_BUILDKIT=0` 强制走旧版守护进程构建。

---

## 三、验证
```bash
docker buildx imagetools inspect wyc6036/travelmap:v3
```
看到 `Platform: linux/amd64` 和 `Platform: linux/arm64` 两条 = 成功。
（`unknown/unknown` 条目是 buildkit 的 attestation manifest，正常无害。）

---

## 四、部署（目标机）
```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```
`docker-compose.prod.yml` 引用 `${DH_USER}/travelmap:latest`，多架构索引会自动拉取对应架构。

---

## 五、清理（可选）
- **远程中间 tag**：hub.docker.com → 仓库 → **Tags** → 删 `v3-amd64`、`v3-arm64`（不影响 `v3`/`latest`，索引按 digest 引用底层 blob）
- **本地**：
  ```bash
  docker rmi wyc6036/travelmap:v3-amd64 wyc6036/travelmap:v3-arm64
  docker buildx rm proxied 2>/dev/null
  ```

---

## 六、报错速查

| 报错特征 | 原因 | 处理 |
|---|---|---|
| `auth.docker.io i/o timeout`，IP 是 `31.13.x / 199.59.x / 202.160.x` | DNS 投毒、请求没走代理 | 查 Docker Desktop 代理（`http://`）、Allow LAN、全局模式 |
| `TLS connect to 127.0.0.1:7890: EOF` | 代理填成了 `https://` | 改成 `http://` |
| 容器/构建连不上代理 | Clash 没开 Allow LAN | 开 Allow LAN |
| `docker buildx --push` 一直超时 | buildkit 拿不到代理 | 改用本手册「守护进程」路线 |
| `docker manifest create ... is a manifest list` | 用了老命令 | 换 `docker buildx imagetools create` |
| `docker push` 中途 `timeout awaiting response headers` | 代理抖动 | 重跑 push，会续传 |
| `imagetools`/`manifest` 超时 | CLI 没走代理 | `export HTTPS_PROXY=...` |

---

## 附：代理分工（重要）
- `docker push` / `docker pull`：走**守护进程**代理（Docker Desktop 设置）
- `docker buildx imagetools` / `docker manifest` / `docker login`：**CLI 直连 registry**，不吃守护进程代理，需 shell `export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890`
