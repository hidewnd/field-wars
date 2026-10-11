# 场域战争

场域战争是一款浏览器多人阵营游戏。玩家加入红、绿、蓝三方，在虚拟城市中探索据点（PO）、收集装备、部署八脚、连接据点并围成领域，为阵营获得积分。当前使用 `beta-v1` 规则与 20 个城区、100 个初始 PO 的地图，每 5 分钟结算据点和领域收益，每 7 天结束一个赛季。

## 主要功能

- **身份与成长**：匿名创建账号、恢复码找回身份、阵营选择、AP 升级与升级礼包；玩家名称支持中英文，最多 20 个字符，主界面右上角同排显示等级与名称，下方显示当前等级 AP 经验进度，L8 显示已满级。
- **地图探索**：点击空白处移动或改道，移动中右键停止，拖动平移、滚轮缩放，手机长按打开快捷菜单。点击菜单外关闭，选择攻击器后保留菜单；玩家周围显示真实的 30 米操作范围。
- **据点经营**：Hack 获取道具，部署八脚占领据点；批量部署默认按背包等级从高到低补槽，也可指定固定等级；单槽支持升级并显示部署人。脚每现实 6 小时损失其等级满能量的 15%，停机后按历史时间补算。
- **散落 XM**：每 5 分钟在每个 PO 周围 45 米内生成 18 点、全图随机生成 200 点，每点 50 XM。仅在地图最大放大倍数下显示无描边的淡紫色光点，缩小后隐藏。XM 未满时进入 30 米范围自动吸收，移动途经也可收集；满能量不消耗，部分吸收后剩余能量留给其他玩家。保留每秒 5 XM 恢复。
- **连线与攻防**：双方端点均满八脚才能连线，消耗目标 Key；L1 据点最低连线范围为 320 米。侵入攻击可选择攻击器等级；支持充能、据点模组、领域建立与摧毁战报。
- **背包管理**：道具使用、回收、丢弃与地面拾取。点击 Key 名称可切回地图并定位到对应 PO；持有友方 PO 的 Key 可在静止时远程充能，不消耗 Key。其他玩家可在 30 米内拾取落地道具；回收返还能量，糖块回收与使用遵循相同规则。
- **新手与运营**：新玩家保存恢复码、选择阵营后自动打开玩法说明，关闭后记录已读；左侧可随时重看。L8 玩家可申请新 PO，管理后台提供申请审核、公告、投诉处理和运营操作。

服务端负责规则判定和资产变更。写操作通过 PostgreSQL 事务、请求收据和玩家版本控制提交，网络结果不明时可核对原请求；WebSocket 通知客户端刷新已提交状态。

XM 是共享资源，由服务端每秒为在线玩家和仍在移动的玩家结算，消耗点位与增加玩家 XM 同事务提交。每批存活 5 分钟，到期替换；停机仅生成当前批次，不补发过期 XM。升级迁移 `007` 后，旧脚下一次衰减最迟为迁移后 6 小时，已到期或更早到期的时刻保持不变，不追溯改写旧积分。

## 技术与目录

| 层次 | 技术 |
| --- | --- |
| 界面 | Vue 3、TypeScript、Vite 7、SVG 地图 |
| 服务 | Node.js 24、Fastify 5、HTTP / WebSocket |
| 数据 | PostgreSQL 18、SQL 迁移、JSONB 状态与事务收据 |
| 部署 | Docker Compose、Nginx 1.28、独立应用与网页镜像 |
| 验证 | Vitest、Playwright、真实 PostgreSQL 集成及迁移测试 |

依赖版本由 `package-lock.json` 锁定，容器基础镜像固定摘要。

```text
apps/field-wars/        Vue 页面、地图、背包、据点详情、账号与新手引导
server/                HTTP / WebSocket、身份、事务存储、运营接口
  migrations/          按顺序执行的数据库与规则迁移
shared/                前后端共享类型、规则引擎、几何与名称校验
  beta-v1.json          当前规则参数
maps/beta-v1.json       城区、初始据点、出生点和地形
tests/                 规则、界面、集成、迁移与负载检查
scripts/               私有配置初始化、备份与独立恢复
deploy/                环境变量示例、应用代理与网关 Nginx 配置
Dockerfile             应用构建及运行镜像
Dockerfile.web         前端构建及 Nginx 镜像
compose.yaml           本机完整部署
compose.server.yaml    192.168.3.61 的服务器覆盖配置
```

## 本地运行

### Docker 一键启动

需要 Docker Engine、Buildx、Docker Compose 和标准 Shell；宿主不需要安装 Node.js 或 PostgreSQL。

```sh
./scripts/init-env.sh
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/health/ready
```

- 游戏：[http://localhost:8080](http://localhost:8080)
- 管理：[http://localhost:8080/admin](http://localhost:8080/admin)
- 管理员密码：私有 `.env` 的 `ADMIN_PASSWORD`。

初始化脚本只在 `.env` 不存在时生成随机密码和会话密钥，不覆盖已有配置。默认仅向宿主回环地址开放网页端口，数据库不开放宿主端口。迁移成功、应用健康后，网页服务才启动。本机 Compose 项目标识沿用 `junction-city`。

```sh
docker compose logs --tail=100 migrate app web
docker compose down
```

`down` 保留数据库卷；不要使用 `down -v` 清除已有游戏数据。

### 源码开发与热更新

需要 Node.js 24 和 npm。先安装依赖，再通过临时 Compose 覆盖文件只向本机开放开发数据库端口：

```sh
npm ci
./scripts/init-env.sh
cat > /tmp/field-wars.dev.yaml <<'YAML'
services:
  db:
    ports:
      - "127.0.0.1:55432:5432"
YAML
docker compose -f compose.yaml -f /tmp/field-wars.dev.yaml up -d --wait db
```

数据库沿用本机 `junction-city` 项目数据。若此前已启动完整应用，先执行 `docker compose stop app web`，避免两个应用执行器同时运行。

在第一个终端启动后端：

```sh
set -a
. ./.env
set +a
export DATABASE_URL="postgresql://game:${DB_PASSWORD}@127.0.0.1:55432/game"
export PUBLIC_ORIGIN=http://localhost:5173
export COOKIE_SECURE=false
export HOST=127.0.0.1
export PORT=3000
npm run migrate
npm run dev
```

在第二个终端启动前端：

```sh
npm run dev:web -- --host localhost --strictPort
```

访问 [http://localhost:5173](http://localhost:5173)。Vite 将 `/api` 和 WebSocket 代理到 `127.0.0.1:3000`；浏览器入口必须与后端 `PUBLIC_ORIGIN` 一致。

## 远程部署与更新

目标服务器为 `192.168.3.61`，项目目录为 `/home/hidewnd/docker/field-wars`。服务器需安装 Docker Engine / Buildx，以及支持 `!override` 的 Docker Compose 2.24.4 或更高版本。SSH 账号须具有项目目录写入及 Docker 操作权限。

### 首次配置

将已提交的源码放入服务器项目目录，在服务器执行：

```sh
cd /home/hidewnd/docker/field-wars
./scripts/init-env.sh
mkdir -p data/postgres backups
chmod 700 backups
```

保留服务器独立生成的 `DB_PASSWORD`、`SESSION_SECRET` 和 `ADMIN_PASSWORD`，不要用本机 `.env` 覆盖。修改服务器 `.env` 的以下非机密配置：

```dotenv
PUBLIC_ORIGIN=https://game.hidewnd.cn
COOKIE_SECURE=true
LAN_ORIGINS=http://192.168.3.61:8080,http://192.168.3.65:8801
WEB_PORT=8080
FIELD_WARS_DATA_DIR=/home/hidewnd/docker/field-wars/data/postgres
```

`PUBLIC_ORIGIN` 和 `LAN_ORIGINS` 只包含协议、主机和端口，不包含 `/fieldwar/` 路径。公网 HTTPS 使用 Secure Cookie；只有显式配置的私网 IPv4 HTTP 来源可使用非 Secure Cookie。写操作继续校验来源和 CSRF。

```sh
docker compose -f compose.yaml -f compose.server.yaml config --quiet
docker compose -f compose.yaml -f compose.server.yaml up -d --build
docker compose -f compose.yaml -f compose.server.yaml ps
curl -fsS http://127.0.0.1:8080/health/ready
```

服务器 Compose 项目标识为 `field-wars`。数据库目录绑定到 `data/postgres/`，不开放数据库宿主端口。

### 更新已有服务器

先构建确认，再停写、备份并迁移。以下命令均在项目目录运行；两份 Compose 配置必须同时使用。

1. 从已确认的提交同步源码。对于未保存 Git 元数据的部署目录，可在开发机通过已配置好的 SSH 登录执行：

   ```sh
   git archive --format=tar HEAD | ssh hidewnd@192.168.3.61 \
     'tar -xf - -C /home/hidewnd/docker/field-wars'
   ```

   归档只包含已提交文件，不包含 `.env`、数据库、备份、依赖或构建产物。若服务器目录本身由 Git 管理，则核对无本地改动后更新到对应提交。记录部署的提交号：`git rev-parse HEAD`。

2. 在服务器检查配置并提前构建镜像，构建失败时旧服务仍可继续运行：

   ```sh
   docker compose -f compose.yaml -f compose.server.yaml config --quiet
   docker compose -f compose.yaml -f compose.server.yaml build
   ```

3. 停止旧应用写入，备份数据库并验证归档可读取：

   ```sh
   docker compose -f compose.yaml -f compose.server.yaml stop app
   umask 077
   backup="backups/game-$(date +%Y%m%d-%H%M%S).dump"
   docker compose -f compose.yaml -f compose.server.yaml exec -T db \
     pg_dump -U game -d game --format=custom --no-owner --no-acl > "$backup"
   docker compose -f compose.yaml -f compose.server.yaml exec -T db \
     pg_restore --list < "$backup" > /dev/null
   ```

4. 启动新版本并检查服务状态：

   ```sh
   docker compose -f compose.yaml -f compose.server.yaml up -d --no-build --pull never
   docker compose -f compose.yaml -f compose.server.yaml ps --all
   docker compose -f compose.yaml -f compose.server.yaml logs --tail=100 migrate app web
   curl -fsS http://127.0.0.1:8080/health/ready
   curl -fsS http://127.0.0.1:8080/api/ruleset
   ```

本次升级包含 `008` 迁移：增加 PO 周边 XM 密度，保留当前批次的剩余点与领取状态，下一次五分钟刷新生效。`007` 迁移：启用散落 XM，将脚的衰减周期改为 6 小时，并将旧脚下一次衰减限制为最迟迁移后 6 小时，保留已到期或更早到期的时刻。旧版本会先按顺序执行 `005`、`006` 等尚未应用的迁移。迁移保持账号和背包资产，未知规则摘要会拒绝启动。迁移成功后不能直接使用不兼容的旧应用回退；应使用匹配源码和备份恢复到独立环境核验，再安排切换。

### 访问入口与网关

| 入口 | 游戏 | 管理 |
| --- | --- | --- |
| 内网直连 | `http://192.168.3.61:8080/` | `/admin` |
| 内网网关 | `http://192.168.3.65:8801/fieldwar/` | `/fieldwar/admin` |
| 公网 HTTPS | `https://game.hidewnd.cn/fieldwar/` | `/fieldwar/admin` |

`192.168.3.65:8801` 的网关配置见 [deploy/nginx-gateway.conf](deploy/nginx-gateway.conf)。它将 `/fieldwar/` 转发到 `192.168.3.61:8080/`，保留 WebSocket 升级，并将 Cookie 路径限制到 `/fieldwar/`。公网穿透入口负责 TLS，转发到该网关；更新游戏应用不会自动修改网关配置。网关首次安装或修改后，需先通过 `nginx -t` 再 reload。

域名与 IP 的浏览器身份彼此独立，换入口时可通过恢复码找回原账号。

## 备份、恢复与验证

本机默认 Compose 部署可使用现有脚本：

```sh
mkdir -p backups
./scripts/backup-db.sh backups/game-local.dump
./scripts/restore-into-new.sh game-restore-1 backups/game-local.dump
WEB_PORT=8081 PUBLIC_ORIGIN=http://127.0.0.1:8081 \
  docker compose -p game-restore-1 up -d --build
```

恢复脚本要求新项目名和不存在的数据卷。服务器备份使用上一节的双 Compose 命令；不要对服务器生产目录执行清卷恢复。数据库备份与私有 `.env` 应分别保存在受控位置。

```sh
npm test
npm run typecheck
npm run build
```

`npm test` 包含规则、几何、路径与来源边界等检查。真实 PostgreSQL 检查需要预先建立独立测试数据库：

- `TEST_DATABASE_URL`：HTTP 集成测试。
- `OPERATIONS_TEST_DATABASE_URL`：运营接口测试，使用独立数据库。
- `MIGRATION_TEST_DATABASE_URL`：规则升级、空库初始化和重复迁移测试，使用另一独立数据库。

测试库名必须含独立的 `test` 段，例如 `field_wars_test`；这些测试会重建表或清空测试数据，不能指向游戏库。未配置时会明确跳过，不能视为通过。

浏览器检查使用 Playwright。例如先启动本地前端，再运行使用模拟接口的交互检查：

```sh
BASE_URL=http://localhost:5173 PLAYWRIGHT_CHANNEL=chrome \
  npm exec -- playwright test tests/browser-interactions.spec.ts --workers=1
```

上述命令需要已安装 Chrome；真实服务浏览器用例需要独立运行环境。构建和功能测试不代表容量指标或生产部署已经通过，运行情况以实际健康检查和验收结果为准。
