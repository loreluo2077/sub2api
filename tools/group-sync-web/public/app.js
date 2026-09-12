const $ = (selector) => document.querySelector(selector)
const elements = {
  supplierList: $('#supplier-list'), supplierEmpty: $('#supplier-empty'), supplierCount: $('#supplier-count'),
  targetList: $('#target-list'), targetEmpty: $('#target-empty'), targetCount: $('#target-count'),
  welcome: $('#welcome-state'), dashboard: $('#dashboard'), dashboardEmpty: $('#dashboard-empty'), dashboardContent: $('#dashboard-content'),
  dashboardName: $('#dashboard-name'), dashboardKind: $('#dashboard-kind'), dashboardUrl: $('#dashboard-url'), syncState: $('#sync-state'), lastRefresh: $('#last-refresh'),
  dialog: $('#site-dialog'), form: $('#site-form'), dialogTitle: $('#site-dialog-title'), formError: $('#site-form-error'),
  siteKind: $('#site-kind'), siteName: $('#site-name'), siteUrl: $('#site-url'), siteEmail: $('#site-email'), sitePassword: $('#site-password'),
  siteRmbPerUsd: $('#site-rmb-per-usd'),
  siteHasPassword: $('#site-has-password'), togglePassword: $('#toggle-site-password'), saveSyncSite: $('#save-sync-site'),
  metricBalance: $('#metric-balance'), metricUser: $('#metric-user'), metricGroups: $('#metric-groups'), metricPlatforms: $('#metric-platforms'),
  metricKeys: $('#metric-keys'), metricActiveKeys: $('#metric-active-keys'), metricHealth: $('#metric-health'), metricResourceState: $('#metric-resource-state'),
  tabs: $('#view-tabs'), search: $('#data-search'), viewContent: $('#view-content'), exportAll: $('#export-all'), exportCurrent: $('#export-current'), toast: $('#toast'),
  wizardOpen: $('#group-key-wizard-open'), importOpen: $('#import-account-open'), syncCurrent: $('#sync-current'),
}

const resourceLabels = {
  settings: '公开设置', current_user: '当前用户', profile: '用户资料', platform_quotas: '平台配额', affiliate: '邀请信息',
  api_keys: 'API Keys', groups: '分组', group_rates: '分组倍率', channels: '渠道', model_plaza: '模型广场',
  usage_snapshot: '用量快照', usage_stats: '用量统计', subscription_summary: '订阅摘要', subscription_progress: '订阅进度',
  subscriptions: '有效订阅', announcements: '公告', redeem_history: '兑换记录', channel_monitors: '渠道监控', payment_plans: '支付套餐', orders: '订单',
}
let sites = []
let selectedId = ''
let currentView = 'overview'
let editingId = ''
let toastTimer
let autoRefreshInFlight = false

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}
function itemsOf(resource) {
  const data = resource?.status === 'ok' ? resource.data : null
  if (Array.isArray(data)) return data
  return Array.isArray(data?.items) ? data.items : []
}
function formatMoney(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-'
}
function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}
function showToast(message) {
  clearTimeout(toastTimer); elements.toast.textContent = message; elements.toast.hidden = false
  toastTimer = setTimeout(() => { elements.toast.hidden = true }, 2600)
}
function selectedSite() { return sites.find((site) => site.id === selectedId) }
async function apiRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const result = await response.json()
  if (!response.ok || result.ok === false) throw new Error(result.message || '请求失败')
  return result
}

async function loadSites() {
  const result = await apiRequest('/api/sites')
  sites = result.sites || []
  if (!sites.some((site) => site.id === selectedId)) selectedId = sites[0]?.id || ''
  renderShell()
}

function renderSiteList() {
  const suppliers = sites.filter((site) => site.kind === 'supplier')
  const targets = sites.filter((site) => site.kind === 'target')
  elements.supplierCount.textContent = suppliers.length
  elements.targetCount.textContent = targets.length
  elements.supplierEmpty.hidden = suppliers.length > 0
  elements.targetEmpty.hidden = targets.length > 0
  elements.exportAll.disabled = !sites.some((site) => site.live || site.fetched_at)
  const render = (list, container) => {
    container.innerHTML = list.map((site) => {
      const state = site.live || site.fetched_at ? 'ready' : ''
      return `<button class="supplier-item ${site.id === selectedId ? 'active' : ''}" data-id="${escapeHtml(site.id)}" type="button">
        <span class="supplier-avatar">${escapeHtml(site.name.slice(0, 2).toUpperCase())}</span>
        <span class="supplier-meta"><strong>${escapeHtml(site.name)}</strong><span>${escapeHtml(new URL(site.base_url).host)}</span></span>
        <i class="supplier-state ${state}"></i>
      </button>`
    }).join('')
  }
  render(suppliers, elements.supplierList)
  render(targets, elements.targetList)
}

function renderShell() {
  renderSiteList()
  const site = selectedSite()
  elements.welcome.hidden = Boolean(site)
  elements.dashboard.hidden = !site
  if (!site) return
  elements.dashboardKind.textContent = site.kind === 'target' ? '目标站点' : '上游站点'
  elements.dashboardName.textContent = site.name
  elements.dashboardUrl.textContent = `${site.base_url} · ${site.email}`
  elements.syncState.textContent = site.loading ? '加载中...' : site.live ? `更新于 ${formatDate(site.live.fetched_at)}` : site.fetched_at ? `上次同步 ${formatDate(site.fetched_at)}` : '未同步'
  elements.lastRefresh.textContent = site.live ? `最后同步 ${formatDate(site.live.fetched_at)}` : site.fetched_at ? `最后同步 ${formatDate(site.fetched_at)}` : '尚未同步'

  // 按站点类型显示操作按钮
  elements.wizardOpen.hidden = site.kind !== 'supplier'
  elements.importOpen.hidden = site.kind !== 'target'

  // 指标卡：优先实时数据，其次已存的账户摘要
  const live = site.live
  const summary = live?.summary
  elements.metricBalance.textContent = formatMoney(summary?.balance ?? site.balance)
  elements.metricUser.textContent = summary?.username || site.username || site.email
  elements.metricGroups.textContent = summary?.groups ?? '-'
  elements.metricPlatforms.textContent = live ? `${new Set(itemsOf(live.resources.groups).map((g) => g.platform).filter(Boolean)).size} 个平台` : '-'
  elements.metricKeys.textContent = summary?.api_keys ?? '-'
  elements.metricActiveKeys.textContent = summary?.api_keys != null ? `${summary.active_api_keys} 个启用` : '-'
  if (summary?.total_resources) {
    const health = Math.round(summary.successful_resources / summary.total_resources * 100)
    elements.metricHealth.textContent = `${health}%`
    elements.metricResourceState.textContent = `${summary.successful_resources} / ${summary.total_resources} 项`
  } else {
    elements.metricHealth.textContent = '-'
    elements.metricResourceState.textContent = '-'
  }

  if (live) {
    elements.dashboardEmpty.hidden = true
    elements.dashboardContent.hidden = false
    renderDashboard(live)
  } else {
    elements.dashboardEmpty.hidden = false
    elements.dashboardContent.hidden = true
    elements.dashboardEmpty.innerHTML = site.loading
      ? '<h3>加载中…</h3><p>正在实时拉取该站点数据。</p>'
      : `<h3>尚未同步</h3><p>点击「刷新数据」实时拉取余额、分组、用量等数据。${site.has_password ? '' : '<br/>该站点未保存密码，请先编辑填写登录密码。'}</p>`
  }
}

async function refreshSite(siteId) {
  const site = sites.find((item) => item.id === siteId)
  if (!site) return
  if (!site.has_password) { showToast('该站点未保存密码，请先编辑填写'); renderShell(); return }
  site.loading = true
  renderShell()
  try {
    const result = await apiRequest('/api/collect', { method: 'POST', body: JSON.stringify({ siteId }) })
    site.live = result
    site.balance = result.summary.balance
    site.username = result.summary.username
    site.fetched_at = result.fetched_at
    site.loading = false
    renderShell()
    showToast(`已刷新 ${site.name} 的 ${result.summary.successful_resources} 项数据`)
  } catch (error) {
    site.loading = false
    renderShell()
    showToast(error.message || '刷新失败')
  }
}

function selectSite(id) {
  selectedId = id
  currentView = 'overview'
  elements.search.value = ''
  renderShell()
  if (sites.find((site) => site.id === id)?.has_password) refreshSite(id)
}

// 顺序刷新所有未加载的上游站点（避免并发触发风控）
async function refreshAllSuppliers() {
  const suppliers = sites.filter((site) => site.kind === 'supplier' && !site.live)
  if (suppliers.length === 0) { renderView(); return }
  showToast(`正在刷新 ${suppliers.length} 个上游站点...`)
  for (const site of suppliers) {
    await refreshSite(site.id)
  }
  renderView()
}

function renderDashboard(result) {
  elements.tabs.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.view === currentView))
  renderView()
}

function table(headers, rows) {
  if (!rows.length) return '<div class="empty-view">当前没有可展示的数据</div>'
  return `<div class="data-table"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}
function queryMatches(values) {
  const query = elements.search.value.trim().toLowerCase()
  return !query || values.some((value) => String(value ?? '').toLowerCase().includes(query))
}
function renderOverview(result) {
  const profile = result.resources.profile.data || result.resources.current_user.data || {}
  const resources = Object.entries(result.resources)
  return `<div class="overview-grid">
    <section class="info-panel"><h3>账户概况</h3><div class="kv-list">
      <div class="kv-row"><span>用户名</span><strong>${escapeHtml(profile.username || profile.name || '-')}</strong></div>
      <div class="kv-row"><span>邮箱</span><strong>${escapeHtml(profile.email || result.site?.email || '-')}</strong></div>
      <div class="kv-row"><span>余额</span><strong>${formatMoney(profile.balance)}</strong></div>
      <div class="kv-row"><span>并发限制</span><strong>${escapeHtml(profile.concurrency || profile.concurrency_limit || '-')}</strong></div>
      <div class="kv-row"><span>账户状态</span><strong>${escapeHtml(profile.status || '-')}</strong></div>
      <div class="kv-row"><span>采集时间</span><strong>${formatDate(result.fetched_at)}</strong></div>
    </div></section>
    <section class="info-panel"><h3>资源状态</h3><div class="resource-grid">${resources.map(([key, resource]) => `
      <div class="resource-item ${resource.status}"><i></i><span>${escapeHtml(resourceLabels[key] || key)}</span><strong>${resource.status === 'ok' ? '正常' : resource.status === 'unavailable' ? '未启用' : '失败'}</strong></div>`).join('')}</div></section>
  </div>`
}
function renderGroups(result) {
  const groups = itemsOf(result.resources.groups).filter((group) => queryMatches([group.name, group.platform, group.description]))
  return table(['分组', '平台', '类型', '默认倍率', '用户倍率', '状态'], groups.map((group) => `<tr>
    <td><div class="primary-text">${escapeHtml(group.name)}</div><div class="secondary-text">${escapeHtml(group.description || '暂无描述')}</div></td>
    <td><span class="tag blue">${escapeHtml(group.platform)}</span></td><td><span class="tag ${group.is_exclusive ? 'gold' : ''}">${group.is_exclusive ? '专属' : group.subscription_type === 'subscription' ? '订阅' : '标准'}</span></td>
    <td>${escapeHtml(group.rate_multiplier)}×</td><td>${group.user_rate_multiplier == null ? '沿用默认' : `${escapeHtml(group.user_rate_multiplier)}×`}</td><td class="ok-text">${group.status === 'active' ? '可用' : escapeHtml(group.status)}</td></tr>`))
}
function renderChannels(result) {
  const channels = itemsOf(result.resources.channels).filter((channel) => queryMatches([channel.name, channel.description, JSON.stringify(channel.platforms || [])]))
  const plazaGroups = result.resources.model_plaza.data?.groups || []
  const channelTable = table(['渠道', '平台', '分组数', '模型数'], channels.map((channel) => {
    const sections = channel.platforms || []
    return `<tr><td><div class="primary-text">${escapeHtml(channel.name)}</div><div class="secondary-text">${escapeHtml(channel.description || '')}</div></td><td>${sections.map((section) => `<span class="tag blue">${escapeHtml(section.platform)}</span>`).join(' ')}</td><td>${sections.reduce((sum, section) => sum + (section.groups?.length || 0), 0)}</td><td>${sections.reduce((sum, section) => sum + (section.supported_models?.length || 0), 0)}</td></tr>`
  }))
  const modelRows = plazaGroups.flatMap((group) => (group.models || []).map((model) => ({ group: group.name, platform: model.platform || group.platform, ...model }))).filter((model) => queryMatches([model.name, model.group, model.platform]))
  return `<div class="section-title"><h3>可用渠道</h3><span>${channels.length} 条</span></div>${channelTable}<div class="section-title"><h3>模型目录</h3><span>${modelRows.length} 条</span></div>${table(['模型', '平台', '所属分组', '输入价', '输出价'], modelRows.map((model) => `<tr><td class="primary-text">${escapeHtml(model.name)}</td><td><span class="tag blue">${escapeHtml(model.platform)}</span></td><td>${escapeHtml(model.group)}</td><td>${escapeHtml(model.pricing?.input_price ?? model.official_pricing?.input_price ?? '-')}</td><td>${escapeHtml(model.pricing?.output_price ?? model.official_pricing?.output_price ?? '-')}</td></tr>`))}`
}
function renderUsage(result) {
  const stats = result.resources.usage_stats.data || {}
  const snapshot = result.resources.usage_snapshot.data || {}
  const models = snapshot.models || []
  return `<div class="overview-grid"><section class="info-panel"><h3>用量总览</h3><div class="kv-list">
    <div class="kv-row"><span>总请求数</span><strong>${escapeHtml(stats.total_requests ?? '-')}</strong></div><div class="kv-row"><span>总 Token</span><strong>${escapeHtml(stats.total_tokens ?? '-')}</strong></div>
    <div class="kv-row"><span>总消费</span><strong>${formatMoney(stats.total_actual_cost ?? stats.total_cost)}</strong></div><div class="kv-row"><span>今日请求</span><strong>${escapeHtml(stats.today_requests ?? '-')}</strong></div>
  </div></section><section class="info-panel"><h3>快照范围</h3><div class="kv-list"><div class="kv-row"><span>开始</span><strong>${escapeHtml(snapshot.start_date || '-')}</strong></div><div class="kv-row"><span>结束</span><strong>${escapeHtml(snapshot.end_date || '-')}</strong></div><div class="kv-row"><span>粒度</span><strong>${escapeHtml(snapshot.granularity || '-')}</strong></div></div></section></div>
  <div class="section-title"><h3>模型消耗</h3><span>${models.length} 条</span></div>${table(['模型', '请求', 'Token', '实际消费'], models.filter((item) => queryMatches([item.model, item.name])).map((item) => `<tr><td class="primary-text">${escapeHtml(item.model || item.name)}</td><td>${escapeHtml(item.requests ?? item.total_requests ?? '-')}</td><td>${escapeHtml(item.tokens ?? item.total_tokens ?? '-')}</td><td>${formatMoney(item.actual_cost ?? item.total_actual_cost ?? item.cost)}</td></tr>`))}`
}
function renderSubscriptions(result) {
  const subscriptions = itemsOf(result.resources.subscriptions).filter((item) => queryMatches([item.group_name, item.status]))
  const progress = itemsOf(result.resources.subscription_progress)
  return table(['订阅分组', '状态', '到期时间', '剩余天数', '进度'], subscriptions.map((item) => {
    const current = progress.find((entry) => entry.subscription_id === item.id || entry.id === item.id) || {}
    return `<tr><td class="primary-text">${escapeHtml(item.group_name || item.group?.name || `#${item.id}`)}</td><td><span class="tag">${escapeHtml(item.status)}</span></td><td>${formatDate(item.expires_at)}</td><td>${escapeHtml(item.days_remaining ?? '-')}</td><td>${escapeHtml(current.monthly_progress ?? current.usage_percent ?? '-')}</td></tr>`
  }))
}
function renderRaw(result) { return `<pre class="raw-json">${escapeHtml(JSON.stringify(result, null, 2))}</pre>` }

// ---------- 价格计算辅助 ----------
function perMtok(usdPerToken) {
  return usdPerToken != null ? usdPerToken * 1_000_000 : null
}
function realPriceRmb(officialUsdPerToken, multiplier, rmbPerUsd) {
  if (officialUsdPerToken == null) return null
  return perMtok(officialUsdPerToken) * (multiplier ?? 1) * (rmbPerUsd ?? 7)
}
function formatRmb(value) {
  if (value == null || !Number.isFinite(value)) return '-'
  return value >= 100 ? `¥${value.toFixed(0)}` : `¥${value.toFixed(2)}`
}

// 遍历 supplier 站点，聚合模型×分组矩阵
function collectModelMatrix() {
  const rows = []
  for (const site of sites) {
    if (site.kind !== 'supplier' || !site.live) continue
    const groups = site.live.resources.model_plaza?.data?.groups || []
    for (const group of groups) {
      const multiplier = group.user_rate_multiplier ?? group.rate_multiplier
      const rmbPerUsd = site.rmb_per_usd ?? 7
      for (const model of group.models || []) {
        const pricing = model.official_pricing || {}
        const inputUsd = pricing.input_price != null ? pricing.input_price : null
        const outputUsd = pricing.output_price != null ? pricing.output_price : null
        rows.push({
          siteId: site.id,
          siteName: site.name,
          groupId: group.id,
          groupName: group.name,
          modelName: String(model.name || '').toLowerCase(),
          displayName: model.name,
          platform: model.platform || group.platform || '-',
          multiplier,
          rmbPerUsd,
          officialInput: inputUsd,
          officialOutput: outputUsd,
          realInput: realPriceRmb(inputUsd, multiplier, rmbPerUsd),
          realOutput: realPriceRmb(outputUsd, multiplier, rmbPerUsd),
        })
      }
    }
  }
  return rows
}

function highlightCell(value, values) {
  if (value == null || !values.length) return ''
  const numeric = values.filter((v) => v != null && Number.isFinite(v))
  if (!numeric.length) return ''
  const min = Math.min(...numeric)
  const max = Math.max(...numeric)
  if (Math.abs(value - min) < 1e-9) return ' class="price-low"'
  if (Math.abs(value - max) < 1e-9) return ' class="price-high"'
  return ''
}

// ---------- 站点对比视图 ----------
function renderSiteCompare() {
  const suppliers = sites.filter((site) => site.kind === 'supplier' && site.live)
  if (!suppliers.length) {
    return `<div class="compare-toolbar"><button id="refresh-all-sites" class="primary-button" type="button">一键刷新全部</button></div>
      <div class="empty-view">暂无已同步的上游站点数据，点击「一键刷新全部」拉取。</div>`
  }
  const rows = suppliers.map((site) => {
    const groups = itemsOf(site.live.resources.groups)
    const platforms = [...new Set(groups.map((g) => g.platform).filter(Boolean))]
    const summary = site.live.summary || {}
    const health = summary.total_resources ? Math.round(summary.successful_resources / summary.total_resources * 100) : null
    return `<tr>
      <td class="primary-text">${escapeHtml(site.name)}</td>
      <td>${platforms.map((p) => `<span class="tag blue">${escapeHtml(p)}</span>`).join(' ') || '-'}</td>
      <td>${groups.length}</td>
      <td>${formatMoney(summary.balance ?? site.balance)}</td>
      <td>${escapeHtml(site.rmb_per_usd ?? 7)}</td>
      <td>${formatDate(site.live.fetched_at)}</td>
      <td>${health != null ? `${health}%` : '-'}</td>
    </tr>`
  })
  const toolbar = `<div class="compare-toolbar"><button id="refresh-all-sites" class="secondary-button" type="button">一键刷新全部</button></div>`
  return toolbar + table(['上游站点', '平台分布', '分组数', '余额', '充值汇率', '最近同步', '数据完整度'], rows)
}

// ---------- 模型对比视图 ----------
let modelCompareRows = []
let selectedModel = ''

function renderModelCompare() {
  modelCompareRows = collectModelMatrix()
  if (!modelCompareRows.length) {
    return `<div class="empty-view">暂无可对比的模型数据。请先刷新上游站点。</div>`
  }
  const modelNames = [...new Set(modelCompareRows.map((r) => r.modelName))].sort()
  const options = `<option value="">全部模型</option>` + modelNames.map((name) => `<option value="${escapeHtml(name)}" ${name === selectedModel ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')

  let body
  if (!selectedModel) {
    body = renderAllModelsSummary(modelNames)
  } else {
    body = renderSingleModelCompare(selectedModel)
  }

  return `<div class="compare-toolbar">
      <label class="model-select"><span>模型选择</span><select id="model-compare-select">${options}</select></label>
    </div>${body}`
}

function renderSingleModelCompare(modelName) {
  const rows = modelCompareRows.filter((r) => r.modelName === modelName)
  if (!rows.length) return '<div class="empty-view">该模型没有可用数据</div>'
  const sample = rows.find((r) => r.officialInput != null || r.officialOutput != null)
  const officialNote = sample
    ? `<div class="official-price">官方基准价：输入 $${perMtok(sample.officialInput)?.toFixed(2) ?? '-'} / 输出 $${perMtok(sample.officialOutput)?.toFixed(2) ?? '-'}（每百万 token, USD）</div>`
    : '<div class="official-price">官方基准价缺失</div>'

  const priceValues = { input: rows.map((r) => r.realInput), output: rows.map((r) => r.realOutput) }
  const rowHtml = rows.map((r) => {
    const missing = r.officialInput == null && r.officialOutput == null
    const rateCell = r.multiplier != null
      ? (r.user_rate_multiplier != null ? escapeHtml(r.multiplier) : `${escapeHtml(r.multiplier)} <span class="tag">默认</span>`)
      : '-'
    const inputCell = missing
      ? '<span class="tag red">官方价缺失</span>'
      : `<span${highlightCell(r.realInput, priceValues.input)}>${formatRmb(r.realInput)}</span>`
    const outputCell = missing
      ? '<span class="tag red">官方价缺失</span>'
      : `<span${highlightCell(r.realOutput, priceValues.output)}>${formatRmb(r.realOutput)}</span>`
    return `<tr>
      <td class="primary-text">${escapeHtml(r.siteName)}</td>
      <td>${escapeHtml(r.groupName)}<span class="tag blue">${escapeHtml(r.platform)}</span></td>
      <td>${rateCell}</td>
      <td>${escapeHtml(r.rmbPerUsd)}</td>
      <td>${inputCell}</td>
      <td>${outputCell}</td>
    </tr>`
  })

  const lowest = rows.filter((r) => r.realInput != null).sort((a, b) => a.realInput - b.realInput)[0]
  const highest = rows.filter((r) => r.realInput != null).sort((a, b) => b.realInput - a.realInput)[0]
  const rates = rows.map((r) => r.multiplier).filter((v) => v != null)
  const rateRange = rates.length ? `${Math.min(...rates)} ~ ${Math.max(...rates)}` : '-'
  const summaryHtml = `<div class="compare-summary">
    <div>最低：${lowest ? `${escapeHtml(lowest.siteName)}/${escapeHtml(lowest.groupName)} 输入 ${formatRmb(lowest.realInput)} 输出 ${formatRmb(lowest.realOutput)}` : '-'}</div>
    <div>最高：${highest ? `${escapeHtml(highest.siteName)}/${escapeHtml(highest.groupName)} 输入 ${formatRmb(highest.realInput)} 输出 ${formatRmb(highest.realOutput)}` : '-'}</div>
    <div>倍率范围：${escapeHtml(rateRange)}</div>
  </div>`

  return officialNote + summaryHtml + table(['上游站点', '分组名', '倍率', '充值汇率', '输入 RMB/百万token', '输出 RMB/百万token'], rowHtml)
}

function renderAllModelsSummary(modelNames) {
  const sections = modelNames.map((name) => {
    const rows = modelCompareRows.filter((r) => r.modelName === name)
    const withPrice = rows.filter((r) => r.realInput != null)
    let summary
    if (!withPrice.length) {
      summary = '<span class="tag red">官方价缺失</span>'
    } else {
      const lowest = withPrice.sort((a, b) => a.realInput - b.realInput)[0]
      summary = `<span class="price-low">${formatRmb(lowest.realInput)}</span> · ${escapeHtml(lowest.siteName)}/${escapeHtml(lowest.groupName)}`
    }
    const rowsHtml = rows.map((r) => {
      const missing = r.officialInput == null && r.officialOutput == null
      return `<tr>
        <td class="primary-text">${escapeHtml(r.siteName)}</td>
        <td>${escapeHtml(r.groupName)}<span class="tag blue">${escapeHtml(r.platform)}</span></td>
        <td>${r.multiplier != null ? escapeHtml(r.multiplier) : '-'}</td>
        <td>${missing ? '<span class="tag red">官方价缺失</span>' : `${formatRmb(r.realInput)} / ${formatRmb(r.realOutput)}`}</td>
      </tr>`
    }).join('')
    return `<details class="model-detail" open>
      <summary><strong>${escapeHtml(name)}</strong><span class="model-summary">${summary}</span><span class="model-count">${rows.length} 组</span></summary>
      <div class="data-table"><table><thead><tr><th>上游站点</th><th>分组名</th><th>倍率</th><th>输入/输出 RMB（百万token）</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    </details>`
  }).join('')
  return `<div class="model-list">${sections}</div>`
}

function renderView() {
  const result = selectedSite()?.live
  const renderers = {
    overview: renderOverview, groups: renderGroups, channels: renderChannels, usage: renderUsage,
    subscriptions: renderSubscriptions, raw: renderRaw,
    modelCompare: () => renderModelCompare(),
    siteCompare: () => renderSiteCompare(),
  }
  const renderer = renderers[currentView]
  try {
    if (currentView === 'model-compare' || currentView === 'site-compare') {
      elements.viewContent.innerHTML = renderer ? renderer() : ''
    } else {
      if (!result) { elements.viewContent.innerHTML = ''; return }
      elements.viewContent.innerHTML = renderer ? renderer(result) : ''
    }
  } catch (error) {
    elements.viewContent.innerHTML = `<div class="empty-view">视图渲染出错：${escapeHtml(error?.message || error)}</div>`
  }
  if (currentView === 'site-compare') {
    const button = document.querySelector('#refresh-all-sites')
    if (button) button.addEventListener('click', refreshAllSuppliers)
  }
  if (currentView === 'model-compare') {
    const select = document.querySelector('#model-compare-select')
    if (select) select.addEventListener('change', () => { selectedModel = select.value; renderView() })
  }
}

// ---------- 站点表单 ----------
function openSiteDialog(site = null, initialKind = 'supplier') {
  editingId = site?.id || ''
  elements.dialogTitle.textContent = site ? `编辑 ${site.name}` : '添加站点'
  elements.form.reset(); elements.formError.hidden = true; elements.siteHasPassword.hidden = true
  elements.siteKind.value = site?.kind || initialKind
  elements.siteName.value = site?.name || ''
  elements.siteUrl.value = site?.base_url || ''
  elements.siteEmail.value = site?.email || ''
  elements.sitePassword.value = ''
  elements.siteRmbPerUsd.value = site?.rmb_per_usd != null ? site.rmb_per_usd : ''
  elements.sitePassword.required = !site?.has_password
  if (site?.has_password) {
    elements.siteHasPassword.hidden = false
    elements.sitePassword.placeholder = '已保存，留空保持不变'
  }
  elements.dialog.showModal(); setTimeout(() => elements.siteName.focus(), 0)
}
function closeSiteDialog() { elements.dialog.close(); editingId = '' }

async function saveSiteFromDialog({ sync }) {
  elements.formError.hidden = true
  const payload = {
    name: elements.siteName.value.trim(),
    kind: elements.siteKind.value,
    baseUrl: elements.siteUrl.value.trim(),
    email: elements.siteEmail.value.trim(),
  }
  if (elements.sitePassword.value) payload.password = elements.sitePassword.value
  const rmb = Number(elements.siteRmbPerUsd.value)
  if (elements.siteRmbPerUsd.value !== '') {
    if (!Number.isFinite(rmb) || rmb <= 0) { elements.formError.textContent = '充值汇率必须是大于 0 的数字'; elements.formError.hidden = false; return }
    payload.rmb_per_usd = rmb
  }
  if (!payload.name || !payload.baseUrl || !payload.email) { elements.formError.textContent = '请填写站点名称、地址和邮箱'; elements.formError.hidden = false; return }
  try {
    let site
    if (editingId) {
      site = (await apiRequest(`/api/sites/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) })).site
    } else {
      site = (await apiRequest('/api/sites', { method: 'POST', body: JSON.stringify(payload) })).site
    }
    selectedId = site.id
    await loadSites()
    closeSiteDialog()
    if (sync) {
      await refreshSite(site.id)
      showToast('站点已保存并刷新')
    } else {
      showToast('站点已保存')
    }
  } catch (error) {
    elements.formError.textContent = error.message || '保存失败'
    elements.formError.hidden = false
  }
}

// ---------- 分组建 Key 向导（3 步） ----------
const wizard = {
  step: 'source',
  sessionId: '',
  groups: [],
  keys: [],
  sourceSiteId: '',
}
const wizardElements = {
  dialog: $('#group-key-wizard'), form: $('#wizard-form'), title: $('#wizard-title'), close: $('#close-wizard'),
  sourceName: $('#wizard-source-name'), sourceUrl: $('#wizard-source-url'), sourceEmail: $('#wizard-source-email'),
  sourcePasswordWrap: $('#wizard-source-password-wrap'), sourcePassword: $('#wizard-source-password'), sourceTogglePassword: $('#wizard-toggle-password'),
  sourceHasPassword: $('#wizard-source-has-password'), sourceError: $('#wizard-source-error'), sourceNext: $('#wizard-source-next'),
  onlyMissing: $('#wizard-only-missing'), groupCount: $('#wizard-group-count'), groupList: $('#wizard-group-list'), keyPrefix: $('#wizard-key-prefix'),
  namePreview: $('#wizard-name-preview'), groupsError: $('#wizard-groups-error'), groupsBack: $('#wizard-groups-back'), groupsNext: $('#wizard-groups-next'),
  revealAll: $('#wizard-reveal-all'), hideAll: $('#wizard-hide-all'), keyList: $('#wizard-key-list'), keysError: $('#wizard-keys-error'), keySummary: $('#wizard-key-summary'),
  keysBack: $('#wizard-keys-back'), keysDone: $('#wizard-keys-done'),
}
const wizardPanels = Array.from(document.querySelectorAll('[data-wizard-panel]'))
const wizardStepButtons = Array.from(document.querySelectorAll('[data-wizard-step]'))

function maskKey(value) { const key = String(value || ''); if (key.length <= 10) return '***'; return `${key.slice(0, 5)}...${key.slice(-4)}` }
function setWizardBusy(button, busy, idleText) { button.disabled = busy; button.textContent = busy ? '处理中...' : idleText }
function showWizardError(key, message) { wizardElements[key].textContent = message; wizardElements[key].hidden = false }
function hideWizardError(key) { wizardElements[key].hidden = true }

function showWizardPanel(step) {
  wizard.step = step
  wizardPanels.forEach((panel) => { panel.hidden = panel.dataset.wizardPanel !== step })
  wizardStepButtons.forEach((button) => { button.classList.toggle('active', button.dataset.wizardStep === step) })
  wizardElements.title.textContent = {
    source: '为上游分组生成并绑定 Key',
    groups: '选择要处理的上游分组',
    keys: '确认上游 Key（仅本次会话）',
  }[step] || ''
}

function openWizard() {
  const site = selectedSite()
  if (!site) return
  wizard.sessionId = ''
  wizard.groups = []
  wizard.keys = []
  wizard.sourceSiteId = site.id
  wizardElements.form.reset()
  ;['sourceError', 'groupsError', 'keysError'].forEach((key) => { wizardElements[key].hidden = true })
  wizardElements.sourceName.value = site.name
  wizardElements.sourceUrl.value = site.base_url
  wizardElements.sourceEmail.value = site.email
  wizardElements.sourcePassword.value = ''
  const hasPassword = site.has_password
  wizardElements.sourceHasPassword.hidden = !hasPassword
  wizardElements.sourcePasswordWrap.hidden = hasPassword
  wizardElements.sourcePassword.required = !hasPassword
  showWizardPanel('source')
  wizardElements.dialog.showModal()
  setTimeout(() => (hasPassword ? wizardElements.sourceNext : wizardElements.sourcePassword).focus(), 0)
}
function closeWizard() {
  wizardElements.dialog.close()
  wizardElements.sourcePassword.value = ''
}

function renderGroupChecklist() {
  const onlyMissing = wizardElements.onlyMissing.checked
  const groups = wizard.groups.filter((group) => !onlyMissing || !group.has_key)
  wizardElements.groupCount.textContent = onlyMissing
    ? `显示 ${groups.length} / ${wizard.groups.length} 个无 Key 分组`
    : `共 ${wizard.groups.length} 个分组`
  if (!groups.length) {
    wizardElements.groupList.innerHTML = '<div class="empty-view">当前没有可展示的分组</div>'
  } else {
    wizardElements.groupList.innerHTML = groups.map((group) => `
      <label class="group-check ${group.has_key ? 'has-key' : ''}">
        <input type="checkbox" data-group-id="${group.id}" checked />
        <span class="group-check-info"><strong>${escapeHtml(group.name)}</strong><span>${escapeHtml(group.platform || '-')} · ${group.is_exclusive ? '专属' : group.subscription_type === 'subscription' ? '订阅' : '标准'}</span></span>
        <em>${group.has_key ? '已有 Key' : '将新建'}</em>
      </label>`).join('')
  }
  updateNamePreview()
}
function updateNamePreview() {
  const firstChecked = wizardElements.groupList.querySelector('input:checked[data-group-id]')
  const prefix = wizardElements.keyPrefix.value.trim()
  const sample = firstChecked ? firstChecked.closest('.group-check').querySelector('strong').textContent : '分组名'
  wizardElements.namePreview.value = `${prefix}${sample}`
}
function renderKeyPreview() {
  const total = wizard.keys.length
  const created = wizard.keys.filter((item) => item.mode === 'created').length
  const existing = wizard.keys.filter((item) => item.mode === 'existing').length
  const failed = wizard.keys.filter((item) => item.mode === 'failed').length
  wizardElements.keySummary.textContent = `共 ${total} 个分组：新创建 ${created}，复用已有 ${existing}，失败 ${failed}。明文仅本次会话有效，可点击显示或导出。`
  if (!total) {
    wizardElements.keyList.innerHTML = '<div class="empty-view">没有生成任何 Key</div>'
    return
  }
  wizardElements.keyList.innerHTML = wizard.keys.map((item) => `
    <div class="key-row ${item.mode === 'failed' ? 'failed' : ''}" data-key="${escapeHtml(item.key)}">
      <span class="key-row-name"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.groupName)}</span></span>
      <code class="key-value">${item.mode === 'failed' ? escapeHtml(item.error || '失败') : maskKey(item.key)}</code>
      ${item.mode === 'failed' ? '' : `<button type="button" class="key-reveal">显示</button>`}
      <span class="tag ${item.mode === 'created' ? '' : item.mode === 'existing' ? 'blue' : 'red'}">${item.mode === 'created' ? '已创建' : item.mode === 'existing' ? '复用已有' : '失败'}</span>
    </div>`).join('')
}
function setKeyReveal(reveal) {
  wizardElements.keyList.querySelectorAll('.key-row').forEach((row) => {
    const value = row.dataset.key || ''
    const code = row.querySelector('.key-value')
    if (!code) return
    code.textContent = reveal ? value : maskKey(value)
    const button = row.querySelector('.key-reveal')
    if (button) button.textContent = reveal ? '隐藏' : '显示'
  })
}

async function submitSourceStep() {
  hideWizardError('sourceError')
  const site = selectedSite()
  if (!site) return
  const payload = { siteId: site.id }
  if (!site.has_password) {
    if (!wizardElements.sourcePassword.value) { showWizardError('sourceError', '请填写该站点的登录密码'); return }
    payload.password = wizardElements.sourcePassword.value
  }
  setWizardBusy(wizardElements.sourceNext, true, '连接上游')
  try {
    const result = await apiRequest('/api/prepare-group-keys', { method: 'POST', body: JSON.stringify(payload) })
    wizard.sessionId = result.sessionId
    wizard.groups = result.groups || []
    if (payload.password) {
      await loadSites()
      wizardElements.sourceHasPassword.hidden = true
      wizardElements.sourcePasswordWrap.hidden = true
    }
    renderGroupChecklist()
    showWizardPanel('groups')
  } catch (error) {
    showWizardError('sourceError', error.message || '连接失败')
  } finally {
    setWizardBusy(wizardElements.sourceNext, false, '连接上游')
  }
}
async function submitGroupsStep() {
  hideWizardError('groupsError')
  const selected = Array.from(wizardElements.groupList.querySelectorAll('input:checked[data-group-id]')).map((input) => Number(input.dataset.groupId))
  if (!selected.length) { showWizardError('groupsError', '请至少选择一个分组'); return }
  setWizardBusy(wizardElements.groupsNext, true, '生成 Key')
  try {
    const result = await apiRequest('/api/prepare-group-keys', { method: 'POST', body: JSON.stringify({ sessionId: wizard.sessionId, selectedGroupIds: selected, keyPrefix: wizardElements.keyPrefix.value.trim() }) })
    wizard.keys = result.groups || []
    renderKeyPreview()
    showWizardPanel('keys')
  } catch (error) {
    showWizardError('groupsError', error.message || '生成失败')
  } finally {
    setWizardBusy(wizardElements.groupsNext, false, '生成 Key')
  }
}

wizardElements.form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (wizard.step === 'source') return submitSourceStep()
  if (wizard.step === 'groups') return submitGroupsStep()
  if (wizard.step === 'keys') { closeWizard(); showToast('分组建Key完成') }
})
wizardElements.close.addEventListener('click', closeWizard)
wizardElements.groupsBack.addEventListener('click', () => showWizardPanel('source'))
wizardElements.keysBack.addEventListener('click', () => { showWizardPanel('groups'); renderGroupChecklist() })
wizardElements.onlyMissing.addEventListener('change', renderGroupChecklist)
wizardElements.keyPrefix.addEventListener('input', updateNamePreview)
wizardElements.groupList.addEventListener('change', updateNamePreview)
wizardElements.revealAll.addEventListener('click', () => setKeyReveal(true))
wizardElements.hideAll.addEventListener('click', () => setKeyReveal(false))
wizardElements.keyList.addEventListener('click', (event) => {
  const button = event.target.closest('.key-reveal')
  if (!button) return
  const row = button.closest('.key-row')
  const code = row.querySelector('.key-value')
  const revealing = button.textContent === '显示'
  code.textContent = revealing ? row.dataset.key : maskKey(row.dataset.key)
  button.textContent = revealing ? '隐藏' : '显示'
})
wizardElements.sourceTogglePassword.addEventListener('click', () => { const visible = wizardElements.sourcePassword.type === 'text'; wizardElements.sourcePassword.type = visible ? 'password' : 'text'; wizardElements.sourceTogglePassword.textContent = visible ? '查看' : '隐藏' })

// ---------- 导入账号（穿梭框） ----------
const importDialog = {
  dialog: $('#import-dialog'), body: $('#import-body'), resultPanel: $('#import-result-panel'),
  sourceSelect: $('#import-source-select'), targetLabel: $('#import-target-label'),
  available: $('#import-available'), selected: $('#import-selected'), availableCount: $('#import-available-count'), selectedCount: $('#import-selected-count'),
  selectAll: $('#import-select-all'), selectNone: $('#import-select-none'), removeSelected: $('#import-remove-selected'),
  moveRight: $('#import-move-right'), moveAllRight: $('#import-move-all-right'), moveLeft: $('#import-move-left'), moveAllLeft: $('#import-move-all-left'),
  passwordWrap: $('#import-password-wrap'), password: $('#import-password'), togglePassword: $('#toggle-import-password'),
  error: $('#import-error'), cancel: $('#import-cancel'), submit: $('#import-submit'), resultDone: $('#import-result-done'),
  resultTitle: $('#import-result-title'), resultSummary: $('#import-result-summary'), resultList: $('#import-result-list'), footerNote: $('#import-footer-note'),
  sourceSiteId: '',
  keys: [],
  selectedKeys: [],
  results: [],
}

function openImportDialog() {
  const target = selectedSite()
  if (!target) return
  importDialog.sourceSiteId = ''
  importDialog.keys = []
  importDialog.selectedKeys = []
  importDialog.results = []
  importDialog.error.hidden = true
  importDialog.resultPanel.hidden = true
  importDialog.body.hidden = false
  importDialog.submit.hidden = false
  importDialog.resultDone.hidden = true
  importDialog.password.value = ''
  importDialog.passwordWrap.hidden = target.has_password
  importDialog.targetLabel.value = `${target.name} · ${target.email}`
  const suppliers = sites.filter((site) => site.kind === 'supplier')
  importDialog.sourceSelect.innerHTML = `<option value="">— 选择上游站点 —</option>` + suppliers.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.name)}</option>`).join('')
  renderTransfer()
  importDialog.dialog.showModal()
  if (suppliers.length && importDialog.sourceSelect.value === '') {
    importDialog.sourceSelect.value = suppliers[0].id
    importDialog.sourceSiteId = suppliers[0].id
    loadImportKeys(suppliers[0].id)
  }
}
function closeImportDialog() {
  importDialog.dialog.close()
  importDialog.sourceSiteId = ''
  importDialog.keys = []
  importDialog.selectedKeys = []
  importDialog.password.value = ''
}

async function loadImportKeys(sourceId) {
  importDialog.keys = []
  importDialog.selectedKeys = []
  importDialog.available.innerHTML = '<div class="empty-view">加载中...</div>'
  try {
    const result = await apiRequest('/api/list-keys', { method: 'POST', body: JSON.stringify({ siteId: sourceId }) })
    importDialog.keys = (result.keys || []).filter((key) => key.key)
    renderTransfer()
  } catch (error) {
    importDialog.available.innerHTML = `<div class="empty-view">拉取失败：${escapeHtml(error.message)}</div>`
    renderTransfer()
  }
}

function renderTransfer() {
  importDialog.availableCount.textContent = importDialog.keys.length
  importDialog.selectedCount.textContent = importDialog.selectedKeys.length
  const available = importDialog.keys.filter((key) => !importDialog.selectedKeys.some((s) => s.key === key.key))
  if (!importDialog.keys.length && !importDialog.selectedKeys.length) {
    importDialog.available.innerHTML = '<div class="empty-view">请先选择来源上游</div>'
  } else {
    importDialog.available.innerHTML = available.length
      ? available.map((key, index) => `<label class="transfer-item" data-avail-index="${index}">
          <input type="checkbox" data-avail-index="${index}" />
          <span class="transfer-item-meta"><strong>${escapeHtml(key.name || key.key)}</strong><span>${escapeHtml(key.group_name || '未分组')}</span></span>
          <code class="key-value">${maskKey(key.key)}</code>
        </label>`).join('')
      : '<div class="empty-view">没有可导入的 Key</div>'
  }
  importDialog.selected.innerHTML = importDialog.selectedKeys.length
    ? importDialog.selectedKeys.map((key, index) => `<label class="transfer-item" data-sel-index="${index}">
        <input type="checkbox" data-sel-index="${index}" />
        <span class="transfer-item-meta"><strong>${escapeHtml(key.name || key.key)}</strong><span>${escapeHtml(key.group_name || '未分组')}</span></span>
        <code class="key-value">${maskKey(key.key)}</code>
      </label>`).join('')
    : '<div class="empty-view">尚未选择 Key</div>'
  importDialog.submit.textContent = `导入所选 ${importDialog.selectedKeys.length} 把 Key`
}

function moveSelectedRight() {
  const checked = Array.from(importDialog.available.querySelectorAll('input[data-avail-index]:checked')).map((input) => Number(input.dataset.availIndex))
  const availableList = importDialog.keys.filter((key) => !importDialog.selectedKeys.some((s) => s.key === key.key))
  for (const index of checked) {
    const key = availableList[index]
    if (key && !importDialog.selectedKeys.some((s) => s.key === key.key)) importDialog.selectedKeys.push(key)
  }
  renderTransfer()
}
function moveSelectedLeft() {
  const checked = Array.from(importDialog.selected.querySelectorAll('input[data-sel-index]:checked')).map((input) => Number(input.dataset.selIndex))
  for (const index of checked.sort((a, b) => b - a)) importDialog.selectedKeys.splice(index, 1)
  renderTransfer()
}
function moveAllRight() {
  for (const key of importDialog.keys) {
    if (!importDialog.selectedKeys.some((s) => s.key === key.key)) importDialog.selectedKeys.push(key)
  }
  renderTransfer()
}
function moveAllLeft() {
  importDialog.selectedKeys = []
  renderTransfer()
}

async function submitImport() {
  importDialog.error.hidden = true
  const target = selectedSite()
  if (!importDialog.selectedKeys.length) { importDialog.error.textContent = '请至少选择一把 Key'; importDialog.error.hidden = false; return }
  const payload = {
    sourceSiteId: importDialog.sourceSiteId,
    siteId: target.id,
    keys: importDialog.selectedKeys.map((key) => ({ name: key.name || key.key, key: key.key, group_name: key.group_name })),
  }
  if (!target.has_password) {
    if (!importDialog.password.value) { importDialog.error.textContent = '请填写目标站点登录密码'; importDialog.error.hidden = false; return }
    payload.password = importDialog.password.value
  }
  importDialog.submit.disabled = true
  importDialog.submit.textContent = '导入中...'
  try {
    const result = await apiRequest('/api/import-keys', { method: 'POST', body: JSON.stringify(payload) })
    importDialog.results = result.results || []
    if (payload.password) {
      await apiRequest(`/api/sites/${target.id}`, { method: 'PUT', body: JSON.stringify({ password: payload.password }) })
      await loadSites()
    }
    renderImportResult()
  } catch (error) {
    importDialog.error.textContent = error.message || '导入失败'
    importDialog.error.hidden = false
  } finally {
    importDialog.submit.disabled = false
    importDialog.submit.textContent = `导入所选 ${importDialog.selectedKeys.length} 把 Key`
  }
}
function renderImportResult() {
  const imported = importDialog.results.filter((item) => item.status === 'imported').length
  const skipped = importDialog.results.filter((item) => item.status === 'skipped').length
  const failed = importDialog.results.filter((item) => item.status === 'failed').length
  importDialog.resultTitle.textContent = `导入完成：成功 ${imported}，跳过 ${skipped}，失败 ${failed}`
  importDialog.resultSummary.textContent = imported + skipped + failed ? `导入 ${imported} 把 · 已存在跳过 ${skipped} 把 · 失败 ${failed} 把` : ''
  if (!importDialog.results.length) {
    importDialog.resultList.innerHTML = '<div class="empty-view">没有导入任何 Key</div>'
  } else {
    importDialog.resultList.innerHTML = table(['Key 名称', 'Key', '结果'], importDialog.results.map((item) => {
      const ok = item.status !== 'failed'
      return `<tr><td class="primary-text">${escapeHtml(item.name)}</td><td><code class="key-value">${maskKey(item.key)}</code></td><td><span class="tag ${ok ? item.status === 'imported' ? '' : 'blue' : 'red'}">${item.status === 'imported' ? '已导入' : item.status === 'skipped' ? '已存在跳过' : '失败'}</span>${item.status === 'failed' ? `<div class="secondary-text">${escapeHtml(item.error || '')}</div>` : ''}</td></tr>`
    }))
  }
  importDialog.body.hidden = true
  importDialog.resultPanel.hidden = false
  importDialog.submit.hidden = true
  importDialog.resultDone.hidden = false
  importDialog.footerNote.textContent = '完成导入后可刷新目标站点查看 Keys。'
}

importDialog.sourceSelect.addEventListener('change', () => {
  const id = importDialog.sourceSelect.value
  importDialog.sourceSiteId = id
  if (id) { loadImportKeys(id) } else { importDialog.keys = []; importDialog.selectedKeys = []; renderTransfer() }
})
importDialog.selectAll.addEventListener('click', () => { importDialog.available.querySelectorAll('input[data-avail-index]').forEach((input) => { input.checked = true }); moveSelectedRight() })
importDialog.selectNone.addEventListener('click', () => { importDialog.available.querySelectorAll('input[data-avail-index]').forEach((input) => { input.checked = false }) })
importDialog.removeSelected.addEventListener('click', moveSelectedLeft)
importDialog.moveRight.addEventListener('click', moveSelectedRight)
importDialog.moveAllRight.addEventListener('click', moveAllRight)
importDialog.moveLeft.addEventListener('click', moveSelectedLeft)
importDialog.moveAllLeft.addEventListener('click', moveAllLeft)
importDialog.cancel.addEventListener('click', closeImportDialog)
importDialog.resultDone.addEventListener('click', closeImportDialog)
importDialog.submit.addEventListener('click', submitImport)
importDialog.togglePassword.addEventListener('click', () => { const visible = importDialog.password.type === 'text'; importDialog.password.type = visible ? 'password' : 'text'; importDialog.togglePassword.textContent = visible ? '查看' : '隐藏' })

// ---------- 事件绑定 ----------
document.querySelector('.supplier-sidebar').addEventListener('click', (event) => {
  const item = event.target.closest('[data-id]')
  if (!item) return
  selectSite(item.dataset.id)
})
$('#add-supplier').addEventListener('click', () => openSiteDialog(null, 'supplier'))
$('#add-target').addEventListener('click', () => openSiteDialog(null, 'target'))
$('#welcome-add').addEventListener('click', () => openSiteDialog(null, 'supplier'))
$('#close-site-dialog').addEventListener('click', closeSiteDialog)
elements.form.addEventListener('submit', (event) => { event.preventDefault(); saveSiteFromDialog({ sync: false }) })
elements.saveSyncSite.addEventListener('click', () => saveSiteFromDialog({ sync: true }))
elements.wizardOpen.addEventListener('click', openWizard)
elements.importOpen.addEventListener('click', openImportDialog)
elements.syncCurrent.addEventListener('click', () => selectedSite() && refreshSite(selectedSite().id))
$('#edit-current').addEventListener('click', () => openSiteDialog(selectedSite()))
$('#remove-current').addEventListener('click', async () => {
  const site = selectedSite()
  if (!site || !confirm(`删除站点“${site.name}”？`)) return
  try {
    await apiRequest(`/api/sites/${site.id}`, { method: 'DELETE' })
    sites = sites.filter((item) => item.id !== site.id)
    selectedId = sites[0]?.id || ''
    renderShell()
    showToast('站点已删除')
  } catch (error) { showToast(error.message || '删除失败') }
})
elements.tabs.addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (!button) return; currentView = button.dataset.view; elements.tabs.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button)); elements.search.value = ''; renderView() })
elements.search.addEventListener('input', renderView)
elements.exportCurrent.addEventListener('click', () => {
  const site = selectedSite()
  downloadJson(site?.live || { name: site?.name, balance: site?.balance, fetched_at: site?.fetched_at }, `${site?.name || 'site'}-${new Date().toISOString().slice(0, 10)}.json`)
})
elements.exportAll.addEventListener('click', () => downloadJson({ exported_at: new Date().toISOString(), sites: sites.filter((item) => item.live).map((item) => ({ name: item.name, base_url: item.base_url, result: item.live })) }, `sub2api-sites-${new Date().toISOString().slice(0, 10)}.json`))
elements.togglePassword.addEventListener('click', () => { const visible = elements.sitePassword.type === 'text'; elements.sitePassword.type = visible ? 'password' : 'text'; elements.togglePassword.textContent = visible ? '查看' : '隐藏' })
function downloadJson(data, filename) { if (!data) return; const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href); showToast('JSON 已导出') }

loadSites()
