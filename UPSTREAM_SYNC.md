# Sub2API 上游同步与定制工作流

本文档记录本仓库（`loreluo2077/sub2api`）如何跟踪官方上游（`Wei-Shaw/sub2api`）更新，并在不影响官方更新的前提下维护本地定制。

## 背景

- 官方仓库：`https://github.com/Wei-Shaw/sub2api`
- 本仓库：`https://github.com/loreluo2077/sub2api`（fork）
- 部署方式：本地打包源码 → 上传服务器 → 服务器构建镜像 → 启动容器（不在本地构建、不推送镜像仓库）

## ① Git 上游跟踪

首次配置（只需一次）：

```bash
git remote add upstream https://github.com/Wei-Shaw/sub2api.git
git fetch upstream
```

## ② 分支策略（核心规则）

目标结构：

```
main   官方纯镜像（唯一允许变动的来源 = 上游）
 └─ prod  定制 + 生产部署分支（= main + 你的全部定制）
      └─ tools/  独立工具子目录（group-sync-web 等，纯新增文件）
```

| 分支 | 允许的写入方式 | 禁止 |
|---|---|---|
| `main` | 只能通过 `git merge upstream/main` | 禁止直接 commit、禁止 push 任何定制 |
| `prod` | 定制 + `git merge main` 跟上上游 | 不直接改 main |

### 现有 tool 分支的迁移

`tool` = `main` + 1 个纯新增提交（`tools/` 目录，无冲突），迁移是无缝的：

```bash
git checkout main
git checkout -b prod
git merge tool
git push -u origin prod
git branch -d tool
git push origin --delete tool
```

### 定制的三条硬性纪律

1. **新增文件优先**：所有自定义组件/页面放新目录（如 `frontend/src/features/custom/`、`tools/`），绝不混入上游已有文件
2. **改现有文件必须集中 + 标记**：只允许改少数几个"入口文件"，且改动全部集中并加注释 `// ==== CUSTOM: <名字> ====`：
   - 前端路由：`frontend/src/router/index.ts` 末尾追加独立块
   - 前端菜单：`frontend/src/components/layout/AppSidebar.vue` 的 `adminNavItems` 数组末尾追加
   - i18n：只在 `frontend/src/i18n/locales/zh/` 末尾追加新 key
3. **每次 merge 冲突范围固定**：由于只改这几个入口文件，上游更新后 merge 冲突只会出现在这几个固定位置，其余全部自动合并

## ③ 自动检查工作流

### 文件位置

`.github/workflows/sync-upstream.yml` — **必须提交到 `main` 分支**，因为 cron 定时任务只在默认分支上运行。这是对"main 纯镜像"规则的唯一例外（一个新增的构建文件，上游没有它，所以 merge 永远不会冲突）。

### 完整工作流内容

```yaml
name: Sync Upstream

on:
  schedule:
    - cron: '0 */6 * * *'   # 每 6 小时运行一次
  workflow_dispatch:         # 支持手动触发（Actions 页面点 "Run workflow"）

permissions:
  contents: write            # 允许推送 sync 分支
  pull-requests: write       # 允许创建/更新 PR

concurrency:
  group: sync-upstream       # 防止并发运行重复建 PR
  cancel-in-progress: false

env:
  UPSTREAM_REPO: Wei-Shaw/sub2api
  SYNC_BRANCH: upstream-sync

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      # 1. 检出 fork 仓库（完整历史，便于 diff 对比）
      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      # 2. 配置 git 身份（PR/分支操作需要）
      - name: Configure git identity
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      # 3. 拉取官方上游（公开仓库，无需 token）
      - name: Fetch upstream
        run: |
          git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
          git fetch upstream main

      # 4. 对比 fork main 与上游 main，算出领先/落后数量
      - name: Compare with upstream
        id: check
        run: |
          AHEAD=$(git rev-list --count main..upstream/main)
          BEHIND=$(git rev-list --count upstream/main..main)
          echo "ahead=$AHEAD"  >> "$GITHUB_OUTPUT"
          echo "behind=$BEHIND" >> "$GITHUB_OUTPUT"
          echo "— fork main 落后上游 $AHEAD 个提交，领先 $BEHIND 个提交 —"
          if [ "$AHEAD" -eq 0 ] && [ "$BEHIND" -eq 0 ]; then
            echo "has_changes=false" >> "$GITHUB_OUTPUT"
          else
            echo "has_changes=true"  >> "$GITHUB_OUTPUT"
          fi

      # 5. 没有更新就安静退出
      - name: Up to date
        if: steps.check.outputs.has_changes == 'false'
        run: echo "✅ 上游无新提交，跳过"

      # 6. 有更新：创建 upstream-sync 分支（指向最新上游）
      - name: Create sync branch
        if: steps.check.outputs.has_changes == 'true'
        run: git checkout -B "$SYNC_BRANCH" upstream/main

      # 7. 推送 sync 分支（force 以便复用同名分支）
      - name: Push sync branch
        if: steps.check.outputs.has_changes == 'true'
        run: git push -f origin "$SYNC_BRANCH"

      # 8. 生成 PR 描述：列出新提交 + 变更文件
      - name: Generate PR body
        if: steps.check.outputs.has_changes == 'true'
        run: |
          OLD_SHA=$(git rev-parse main)
          NEW_SHA=$(git rev-parse upstream/main)
          {
            echo "## 🔄 上游更新摘要"
            echo ""
            echo "检测到 **${UPSTREAM_REPO}** 有新提交（fork main 落后上游 **${{ steps.check.outputs.ahead }}** 个提交）。"
            echo ""
            echo "### 新增提交（main..upstream/main）"
            echo '```'
            git log --oneline main..upstream/main
            echo '```'
            echo ""
            echo "### 变更文件统计"
            echo '```'
            git diff --stat main upstream/main
            echo '```'
            echo ""
            echo "### 官方对比链接"
            echo "https://github.com/${UPSTREAM_REPO}/compare/${OLD_SHA}...${NEW_SHA}"
            echo ""
            echo "### ⚠️ 合并后请同步 prod"
            echo '```bash'
            echo "git checkout prod && git merge main"
            echo "git push origin prod"
            echo '```'
          } > /tmp/pr-body.md

      # 9. 创建 PR（若同名 PR 已存在则更新内容，避免堆积）
      - name: Create or update PR
        if: steps.check.outputs.has_changes == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          EXISTING=$(gh pr list --head "$SYNC_BRANCH" --json number --jq '.[0].number // empty')
          if [ -n "$EXISTING" ]; then
            gh pr edit "$EXISTING" --body-file /tmp/pr-body.md
            echo "已更新现有 PR #$EXISTING"
          else
            gh pr create \
              --base main \
              --head "$SYNC_BRANCH" \
              --title "⬆️ 同步上游更新（+${{ steps.check.outputs.ahead }} 提交）" \
              --body-file /tmp/pr-body.md
          fi
```

### 工作流行为说明

| 场景 | 行为 |
|---|---|
| 上游无更新 | 安静退出，不产生任何 PR |
| 上游有新提交 | 建 `upstream-sync` 分支 → 开 PR，PR 描述自动含**提交清单**和**变更文件统计** |
| 上游连续更新多个版本 | **复用同一个 PR**（force 重置分支 + 更新描述），不会堆积多个 PR |
| fork main 被人直接 push（违规） | `behind > 0`，PR 会显示差异；需人工检查，按规则应避免 |

## ④ 本地手动检查脚本

新建 `scripts/check-upstream.sh`（本地用，不参与 CI）：

```bash
#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/Wei-Shaw/sub2api.git"

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

git fetch "$UPSTREAM_REMOTE" main

AHEAD=$(git rev-list --count main.."$UPSTREAM_REMOTE/main" 2>/dev/null || echo 0)
if [ "$AHEAD" -eq 0 ]; then
  echo "✅ 本地 main 已是最新，上游无新提交"
else
  echo "🔔 上游有 $AHEAD 个新提交："
  echo ""
  git log --oneline main.."$UPSTREAM_REMOTE/main"
  echo ""
  echo "变更文件统计："
  git diff --stat main "$UPSTREAM_REMOTE/main"
fi
```

## ⑤ 完整更新流程（每次官方发布后）

```
1. GitHub 收到 "⬆️ 同步上游更新" 的 PR
2. 看 PR 描述 → 知道上游改了哪些 commit、哪些文件
3. 点 Merge（合入 main）→ main 同步完成
4. 本地：
   git checkout prod && git merge main   # 上游改动合进定制分支
   git push origin prod
   # 若有冲突，只在固定入口文件，按 CUSTOM 标记解决
5. 部署：
   本地打包源码 → 上传服务器 → 服务器构建镜像 → docker compose up -d
```

## ⑥ 部署方式（不在本地构建镜像）

Dockerfile 是完整多阶段构建（前端 node 构建 + 后端 Go 交叉编译），服务器只需装 Docker，不需要 Go/Node。

流程：本地 `git archive` 打包源码 → scp/rsync 上传 → 服务器 `docker build` → `docker compose up -d`。
