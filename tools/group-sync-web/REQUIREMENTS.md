# group-sync-web 改造需求

## 1. 背景与目标

`tools/group-sync-web` 是一个本地运行的多上游数据控制台（Node + 原生 HTTP + SQLite + 原生前端，无任何前端框架/构建步骤）。当前能力：多站点（supplier/target）管理、普通用户视角实时采集上游数据、分组建 Key、导入 Key。

**本次改造目标**：让工具从"操作工具"升级为"决策数据工具"，补齐价格对比能力，支撑运营方基于真实价格选择上游站点与分组：

1. 充值汇率配置（每个上游站点）
2. 站点维度对比视图
3. 模型维度对比视图

## 2. 范围

### 做（本次 3 项）

1. **充值汇率配置**（每个上游站点，方案 A：填"1 美元额度 = 多少元人民币"，1:1 站点填 1，7 元站填 7）
2. **站点维度对比视图**
3. **模型维度对比视图**（同一模型在不同站点、不同分组下倍率不同，需按模型聚合展示）

### 不做

- 健康度检查 / 健康分
- 历史表 + 趋势
- 模型消耗透视 / 预计节省列
- 密码加密、TOTP、工程加固

### 硬性约束

- **不做密码加密**：站点账号密码继续明文存 SQLite `data.db`（维持现状）。
- **不落库敏感数据**：API Key 明文、分组、用量明细不落库；新增持久化只存聚合摘要/快照。
- **无外部运行时依赖**：不引入 npm 依赖、不引入构建步骤、不引入前端框架。第三方库仅允许 CDN `<script>` 引入且须说明离线降级；**不引入图表库**。
- **SQLite 用现有 `node:sqlite` 的 `DatabaseSync`**（server.mjs 已用），沿用 `db.prepare().run()/all()/get()` 风格。
- **保持现有交互风格**：`data-table` / `kv-list` / `info-panel` / `tag` 等现有 CSS 类，`showToast`、`escapeHtml`、`formatMoney`、`apiRequest`、`queryMatches` 等工具函数（public/app.js 已有）。

## 3. 数据来源与价格公式

### 3.1 数据源

每个站点登录后采集的 `model-plaza`（`site.live.resources.model_plaza`），结构已确认：

- `groups[]`，每个分组有 `rate_multiplier`、`user_rate_multiplier`（可空）、`models[]`
- 每个 `model` 有 `name`、`platform`、`pricing`（分组配置价，本需求不使用）、`official_pricing`（官方参考价，USD/每 token，字段 `input_price` / `output_price`）

### 3.2 官方基准价（计价单位调查结论）

官方价格文件（`backend/resources/model-pricing/model_prices_and_context_window.json`，来自 `Wei-Shaw/model-price-repo`）**统一按美元计价**：

- 字段为 `input_cost_per_token: 3e-06`（即 $3/百万 token），无任何人民币（CNY/RMB）字段。
- 国产模型（DeepSeek / GLM 等）在文件中同样统一换算为美元，**不存在人民币官方价**。
- model-plaza 的 `official_pricing` 直接来自该官方文件（USD per token）。

因此，用户观察到的"人民币计价"实际发生在**充值兑换**层面，而非官方定价层面。

### 3.3 价格公式（用户指定标准，统一换算）

```
官方基准价 (USD/百万token) = official_pricing.input_price × 1,000,000
上游标价   (USD/百万token) = 官方基准价 × 倍率
倍率                        = user_rate_multiplier ?? rate_multiplier（分组级）
真实成本   (RMB/百万token) = 上游标价 × rmb_per_usd（站点级配置）
```

输入价、输出价分别计算，单位展示为 RMB/百万 token。

## 4. 数据模型变更（server.mjs）

`sites` 表新增列：

```sql
ALTER TABLE sites ADD COLUMN rmb_per_usd REAL DEFAULT 7.0;
```

- 兼容迁移：复用现有 `PRAGMA table_info` 模式（`if (!siteColumns.has('rmb_per_usd')) db.exec(...)`）。
- `siteToDto` 返回 `rmb_per_usd`。
- 站点创建/更新（`dbUpsertSite` / `dbUpdateSite` / `handleSites`）支持读写该字段；后端默认 `7.0`，非法值（NaN / ≤0）回退默认。

## 5. 后端改动（server.mjs）

**唯一改动点**：`sites` 表加 `rmb_per_usd` 字段 + CRUD 透传。

**不需要**新增任何采集/聚合接口——两个对比视图均在前端聚合各站点已加载的 `live` 数据。

## 6. 前端改动（public/）

### 6.1 站点表单加充值汇率

- `index.html` 站点表单 + `app.js` `openSiteDialog` / `saveSiteFromDialog`：
  - 表单加「充值汇率」（数字输入，`step="0.01"`，`min="0.1"`，placeholder 默认 7.0，注释：`1 美元额度 = 多少元人民币（1:1 站点填 1）`）。
  - 保存/编辑时带上 `rmb_per_usd`；编辑已有站点回填当前值。

### 6.2 站点维度对比视图

- `index.html` view-tabs 新增 tab「站点对比」（`data-view="site-compare"`）。
- `app.js` `renderers` 注册 `siteCompare` 渲染函数。
- **前置**：新增「一键刷新全部」——在站点对比视图顶部，对每个未刷新的 supplier 站点顺序调用现有 `refreshSite`，完成后渲染；已有 `live` 的站点直接复用。
- 表格列：站点名、平台分布（`groups[].platform` 去重）、分组数、余额、充值汇率 `rmb_per_usd`、最近同步时间、数据完整度（`summary.successful_resources / total_resources` %）。支持 `queryMatches` 搜索。

### 6.3 模型维度对比视图（核心）

- `index.html` view-tabs 新增 tab「模型对比」（`data-view="model-compare"`）；`renderers` 注册。
- **模型选择器**：顶部一个下拉列出所有 supplier 站点出现过的模型名（转小写去重、按名称排序），另加一个「全部模型」选项。
- **选中某模型后的表格**：每行 = 一个「站点 × 分组」组合。列：上游站点名、分组名、倍率（`user_rate_multiplier ?? rate_multiplier`）、充值汇率、输入真实价（RMB/百万 token）、输出真实价（RMB/百万 token）。
- **倍率/价格高亮**：对输入价，最低值绿色高亮、最高值红色高亮（输出价同理，或用"列内最低/最高"逻辑）。
- **汇总行**（表格上方或下方）：
  - `最低：{站点}/{分组} 输入 ¥x 输出 ¥y`
  - `最高：{站点}/{分组} 输入 ¥x 输出 ¥y`
  - `倍率范围：min ~ max`
- **「全部模型」模式**：按模型分组折叠的清单，每个模型一行显示「最低价站点/分组 + 价格」，可展开看明细。
- **缺失处理**：模型无 `official_pricing` → 显示「官方价缺失」，仍展示倍率与汇率供参考；`user_rate_multiplier` 缺失 → 倍率列显示 `rate_multiplier` 并标注「默认」。
- **平台一致性**：同一模型名跨平台出现时，按模型名聚合展示所有站点；行内标注 `platform`。

### 6.4 计算辅助函数（app.js 新增）

```js
function perMtok(usdPerToken) {
  return usdPerToken != null ? usdPerToken * 1_000_000 : null
}
function realPriceRmb(officialUsdPerToken, multiplier, rmbPerUsd) {
  if (officialUsdPerToken == null) return null
  return perMtok(officialUsdPerToken) * (multiplier ?? 1) * (rmbPerUsd ?? 7)
}
function collectModelMatrix(sites) {
  // 遍历 supplier 站点 live.resources.model_plaza.groups[].models[]
  // 返回 [{site, groupId, groupName, model, platform, multiplier, rmbPerUsd, officialInput, officialOutput, realInput, realOutput}]
}
```

「模型下拉的选项」由 `collectModelMatrix` 派生（模型名去重）。

## 7. UI 线框图（模型对比视图）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 上游聚合控制台                  [总览][分组][渠道与模型][模型对比][站点对比]│
├──────────────────────────────────────────────────────────────────────┤
│ 模型选择  [deepseek-chat  ▼]   (或: 全部模型)                          │
│ 官方基准价: 输入 $0.27 / 输出 $1.10 (每百万 token, USD)                 │
│                                                                       │
│ 真实成本 (RMB / 百万 token)                                            │
│ ┌─────────┬──────────────┬──────┬──────┬─────────┬─────────┐          │
│ │ 上游站点 │ 分组名        │ 倍率  │ 汇率  │ 输入RMB  │ 输出RMB  │          │
│ ├─────────┼──────────────┼──────┼──────┼─────────┼─────────┤          │
│ │ 站点A   │ 标准销售组     │ 1.0  │ 1.0  │ 0.27    │ 1.10    │          │
│ │ 站点B   │ deepseek-x    │ 1.2  │ 7.0  │ 2.27    │ 9.24    │          │
│ │ 站点B   │ 促销组(默认)   │ 0.9  │ 7.0  │ 1.70    │ 6.93    │          │
│ └─────────┴──────────────┴──────┴──────┴─────────┴─────────┘          │
│ 最低: 站点A/标准销售组  输入 ¥0.27 输出 ¥1.10                            │
│ 最高: 站点B/deepseek-x 输入 ¥2.27 输出 ¥9.24                            │
│ 倍率范围: 0.9 ~ 1.2                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

## 8. 验收标准

- [ ] 站点可设置 `rmb_per_usd`（默认 7.0），保存/编辑/回填正常，旧库迁移不报错。
- [ ] 「站点对比」在 ≥2 个 supplier 站点时正常显示；未刷新站点有「一键刷新全部」触发，刷新后表格数据准确。
- [ ] 「模型对比」下拉列出所有模型名；选中后列出所有「站点 × 分组」组合，真实价 = 官方价 × 1,000,000 × 倍率 × 汇率 计算正确（可手工用已知数字核对）。
- [ ] 最低/最高高亮与汇总行正确；无 `official_pricing` 的模型显示「官方价缺失」不崩溃。
- [ ] 回归：站点 CRUD、采集、分组建 Key、导入 Key、其余视图、搜索、导出不受影响；`node server.mjs` 无报错。

## 9. 注意事项

- **不引入任何依赖/构建/框架**；新 UI 沿用现有 `data-table` / `tag` / `info-panel` 类与工具函数（`escapeHtml` / `formatMoney` / `apiRequest` / `queryMatches`）。
- 两个对比视图都不落库、不新增后端接口，纯前端聚合 `site.live`。
- 「一键刷新全部」**顺序执行**（不要并发打多个上游，避免触发风控）。
- 模型名归一化：转小写即可，不要过度模糊匹配；不同平台同名模型保留在聚合结果中（行内带 platform 标注）。
- 同一模型名跨平台同名模型默认「按模型名合并、展开明细」；如需「模型名 + 平台组合成独立选项」另行确认。
