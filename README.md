# 场域战争

基于《游戏设计初稿》0.6 的浏览器多人游戏内测实现。玩家匿名加入红、绿、蓝三方，在虚拟城市中移动、Hack、部署八脚、攻防充能和连线成场；五分钟计分，七天结算。运行世界采用唯一的 `beta-v1` 规则与 100 点聚簇地图。

## 本机部署

需要 Docker Engine、Compose 和标准 Shell。无需宿主 Node.js、Python 或 PostgreSQL。

```sh
./scripts/init-env.sh
docker compose up -d --build
docker compose ps
```

游戏入口为 [http://localhost:8080](http://localhost:8080)，管理入口为 [http://localhost:8080/admin](http://localhost:8080/admin)。管理员密码由初始化脚本生成，保存在私有 `.env` 的 `ADMIN_PASSWORD`。初始化脚本不会覆盖已有配置。默认仅绑定回环地址，数据库不对宿主开放端口。

停止使用 `docker compose down`，数据库卷会保留。升级前先备份；不要使用删除数据卷的选项。配置、HTTPS、升级、备份与独立恢复步骤见[部署说明](docs/部署说明.md)。

## 服务器部署

服务器目录为 `/home/hidewnd/docker/field-wars`。需要 Docker Compose 2.24.4 或更高版本；使用 `compose.server.yaml` 覆盖本机配置，部署标识为 `field-wars`。

执行 `./scripts/init-env.sh` 生成独立的私有配置，再在 `.env` 中设置 `PUBLIC_ORIGIN=https://fieldwars.hidewnd.cn`、`COOKIE_SECURE=true`、`LAN_ORIGIN=http://192.168.3.61:8080`。保留自动生成的数据库、管理员密码和会话密钥，不要复用本机配置。

```sh
mkdir -p data/postgres
docker compose -f compose.yaml -f compose.server.yaml up -d --build
docker compose -f compose.yaml -f compose.server.yaml ps
```

内网入口为 `http://192.168.3.61:8080`，管理入口为 `/admin`。内网穿透应将 `https://fieldwars.hidewnd.cn` 转发到该 HTTP 入口，保留原始 Host，支持 WebSocket；域名证书由穿透入口负责。域名与 IP 的浏览器身份各自隔离，可用恢复码迁移身份。

只有显式配置的私网 IPv4 HTTP 来源可使用非 Secure Cookie；域名 HTTPS 会话继续使用 Secure Cookie，HTTP 与 WebSocket 都核对允许来源，写请求还需 CSRF 令牌。数据库不开放宿主端口，数据持久化到 `data/postgres/`；可用 `FIELD_WARS_DATA_DIR` 指定另一绝对路径。

备份时使用同一组配置，例如 `docker compose -f compose.yaml -f compose.server.yaml exec -T db pg_dump -U game -d game --format=custom --no-owner --no-acl > backup.dump`。升级前先完成备份，保留 `.env` 与 `data/`。以下设计文档及历史证据仅保留在本地，不随源码仓库上传。

## 设计和验收入口

| 文件 | 用途 |
| --- | --- |
| [游戏设计初稿](游戏设计初稿.md) | 完整基础设计及候选方案，保留原评审语义 |
| [冻结内测规则](docs/内测规则.md) | 本轮选择、运行边界、规则与地图摘要 |
| [初版开发计划](docs/初版开发计划.md) | M0–M5 交付顺序、退出条件及交付范围 |
| [验收追踪](docs/验收追踪.md) | 真实数据库、浏览器、部署、故障及容量验证记录；未达项单独列出 |
| [部署说明](docs/部署说明.md) | 初始化、启动、管理员访问、升级、备份和恢复 |

“可运行”与“全部容量指标通过”分别验收。请以验收追踪中的实测结果判断内测规模，不将构建通过等同于 500 次/秒攻击吞吐达标。

## 源码结构

- `apps/field-wars/`：Vue 3 单页应用与 SVG 交互地图，生产环境由 Nginx 提供。
- `server/`：Fastify HTTP/WebSocket、身份、世界串行事务、运营接口和 SQL 迁移。
- `shared/`：前后端共享契约、纯规则引擎、整数几何与冻结规则 JSON。
- `maps/beta-v1.json`：运行地图，含 20 城区、100 PO、20 出生点及冻结河铁地形。
- `tests/`：规则、几何、真实 PostgreSQL 集成、浏览器和独立负载工具。
- `scripts/`、`deploy/`：部署初始化、备份恢复与 Web 代理配置。

开发使用 Node.js 24；精确依赖版本由 `package-lock.json` 锁定。`npm ci` 后可执行 `npm run typecheck`、`npm run build`。不连接数据库的规则检查为 `npx vitest run tests/engine.test.ts tests/geometry.test.ts`。真实数据库测试要求独立的 `TEST_DATABASE_URL`，库名必须含独立 `test` 段；测试会清空该测试库，不能指向日常内测数据库。未配置测试库时明确跳过，不算通过。

## 保留的设计材料

原 100 点分散地图 `maps/map-initial.json` 及原 SVG/PNG 保留为对照；`review-evidence/cluster-review-v1.json` 是运行地图的聚簇候选来源。运行时只读取 `maps/beta-v1.json`，地图中的节点由数据库绘制，背景不带旧 PO 标记。

旧 v0.3、v0.4、v0.5 设计稿及交接材料已退出当前阅读入口，原字节保留在 `archive/设计历史稿及原始材料-2026-10-08.zip`，目录见 `archive/归档清单.json`。旧评审状态仅代表当时证据。静态设计审计可用 `python3 review-evidence/audit_design.py --generate-candidate` 复现；该命令不修改冻结运行地图，也不能替代游戏运行验收。
