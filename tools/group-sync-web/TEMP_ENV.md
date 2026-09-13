# 临时复现环境清单（可随时清除）

> 用途：为验证「导入账号」功能，在本地启动的一套真实 Sub2API 后端复现环境。
> **与本仓库业务无关，确认不再需要后按本清单清除即可。**
> 最后更新：2026-09-14

---

## 一、正在运行的进程（全部为本次排查临时启动）

| 进程 | PID | 端口 | 说明 |
|------|-----|------|------|
| PostgreSQL 16 | `postgres` (主进程 54483) | 5499 | 数据目录在系统临时目录，见下 |
| Redis | `redis-server` (61948) | 6379 | brew 安装的 redis-server，`--daemonize yes` 手动启动 |
| Sub2API 后端 | `sub2api-server` (63555) | 5498 | 编译产物为临时目录二进制，配置见 `config.yaml` |
| 临时 group-sync 副本 | `node gs-repro/server.mjs` (67538) | 4197 | 仅为复现用的临时工具实例，代码在临时目录 |

> ⚠️ **不要清除**以下进程（非临时环境，属于日常工作）：
> - `node server.mjs` (70937) → `127.0.0.1:4178`：**正式使用的 group-sync-web 工具**（重启后已加载最新代码）
> - `node` 3000 / `node` 3456：其他本地服务

### 停进程命令

```bash
# 停后端
kill 63555

# 停 Redis
kill 61948
# 或：redis-cli shutdown

# 停 PostgreSQL（连带子进程一起停）
/opt/homebrew/Cellar/postgresql@16/16.13/bin/pg_ctl \
  -D /var/folders/40/m2bbpvps58z8z6p_snknzpr40000gn/T/opencode/pgdata stop
# 若 kill 主进程 54483 也可，pg_ctl 更干净

# 停临时 group-sync 副本
kill 67538
```

---

## 二、临时目录文件（系统临时区，OS 可能自动清理，但清除前先停对应进程）

根目录：`/var/folders/40/m2bbpvps58z8z6p_snknzpr40000gn/T/opencode/`

| 路径 | 内容 |
|------|------|
| `pgdata/` | PostgreSQL 数据目录（含测试库 `sub2api_test`） |
| `sub2api-server` | 后端二进制（约 164MB，Go 编译产物） |
| `gs-repro/` | 临时 group-sync-web 副本（含独立 `data.db`） |
| `bcryptgen/`、`bcryptgen2/` | 生成 admin 密码 bcrypt 哈希的临时 Go 程序 |
| `.s.PGSQL.5499`、`.s.PGSQL.5499.lock` | Postgres unix socket（停库后消失） |

```bash
# 停止进程后，一键删除整个临时目录
rm -rf /var/folders/40/m2bbpvps58z8z6p_snknzpr40000gn/T/opencode
```

---

## 三、工作区内的残留文件（本次复现写入了仓库目录）

| 路径 | 说明 |
|------|------|
| `/Users/a1/Documents/ai/sub2api/config.yaml` | 安装时写入的后端配置，**含自动生成的 JWT secret**（仅测试用） |
| `/Users/a1/Documents/ai/sub2api/.installed` | 安装锁文件（0400 只读） |
| `/Users/a1/Documents/ai/sub2api/data/` | 后端运行生成：`model_pricing.json`、`model_pricing.sha256`、`pages/`、`plugins/` |

```bash
cd /Users/a1/Documents/ai/sub2api
rm -f config.yaml .installed
rm -rf data/
```

---

## 四、/tmp 日志文件（本次复现产生）

| 文件 | 说明 |
|------|------|
| `/tmp/backend.log`、`/tmp/backend2.log` | 后端启动日志 |
| `/tmp/pg.log`、`/tmp/initdb.log` | PostgreSQL 启动/初始化日志 |
| `/tmp/gs-repro.log`、`/tmp/group-sync-restart.log` | 临时工具实例日志 |
| `/tmp/groupsync-4178.log`、`/tmp/gs-final.log`、`/tmp/gs_server.log`、`/tmp/gs-server.log` | 早期调试日志（可一并清除） |

```bash
rm -f /tmp/backend.log /tmp/backend2.log /tmp/pg.log /tmp/initdb.log \
      /tmp/gs-repro.log /tmp/group-sync-restart.log \
      /tmp/groupsync-4178.log /tmp/gs-final.log /tmp/gs_server.log /tmp/gs-server.log
```

---

## 五、软件依赖（本次为复现额外安装）

| 软件 | 安装方式 | 说明 |
|------|----------|------|
| `redis`（brew） | `brew install redis` | 后端安装流程强依赖 Redis。若确定不再需要可 `brew uninstall redis`；**卸载前先停进程** |
| PostgreSQL 16（brew） | 原本已存在（Homebrew 自带） | 无需卸载 |

---

## 六、测试环境数据快照（清除前如需保留请备份）

- 数据库：`sub2api_test`（`127.0.0.1:5499`，用户 `postgres`，trust 认证，无密码）
- 管理员账号：`admin@test.com` / `Admin123!`（人工 SQL 插入，非安装流程生成）
- 数据量：users=1、groups=2、accounts=1（`真实上游-GPT-KEY-1`）、api_keys=1
- 复现的关键结论：`POST /api/v1/admin/accounts` 返回 `code:0` 即账号已落库；
  `GET /v1/models` 对零余额 Key 会返回 `403 INSUFFICIENT_BALANCE`，导致导入时模型同步失败 → Key 被跳过。

---

## 七、一键清除清单（核对用）

- [ ] 停进程：`kill 63555 67538`；`redis-cli shutdown`；`pg_ctl -D .../pgdata stop`
- [ ] 删临时目录：`rm -rf /var/folders/40/m2bbpvps58z8z6p_snknzpr40000gn/T/opencode`
- [ ] 删工作区残留：`rm -f config.yaml .installed && rm -rf data/`
- [ ] 删 /tmp 日志（见第四节）
- [ ] 可选：`brew uninstall redis`
