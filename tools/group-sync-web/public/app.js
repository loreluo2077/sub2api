const $ = (selector) => document.querySelector(selector)
const elements = {
  supplierList: $('#supplier-list'), supplierEmpty: $('#supplier-empty'), supplierCount: $('#supplier-count'),
  welcome: $('#welcome-state'), dashboard: $('#dashboard'), dashboardEmpty: $('#dashboard-empty'), dashboardContent: $('#dashboard-content'),
  dashboardName: $('#dashboard-name'), dashboardUrl: $('#dashboard-url'), syncState: $('#sync-state'), lastRefresh: $('#last-refresh'),
  dialog: $('#supplier-dialog'), form: $('#supplier-form'), dialogTitle: $('#dialog-title'), formError: $('#form-error'), submit: $('#submit-supplier'),
  supplierName: $('#supplier-name'), baseUrl: $('#base-url'), email: $('#email'), password: $('#password'), togglePassword: $('#toggle-password'),
  twoFactor: $('#two-factor-section'), totpCode: $('#totp-code'), maskedEmail: $('#masked-email'),
  metricBalance: $('#metric-balance'), metricUser: $('#metric-user'), metricGroups: $('#metric-groups'), metricPlatforms: $('#metric-platforms'),
  metricKeys: $('#metric-keys'), metricActiveKeys: $('#metric-active-keys'), metricHealth: $('#metric-health'), metricResourceState: $('#metric-resource-state'),
  tabs: $('#view-tabs'), search: $('#data-search'), viewContent: $('#view-content'), exportAll: $('#export-all'), toast: $('#toast'),
}

const resourceLabels = {
  settings: '公开设置', current_user: '当前用户', profile: '用户资料', platform_quotas: '平台配额', affiliate: '邀请信息',
  api_keys: 'API Keys', groups: '分组', group_rates: '分组倍率', channels: '渠道', model_plaza: '模型广场',
  usage_snapshot: '用量快照', usage_stats: '用量统计', subscription_summary: '订阅摘要', subscription_progress: '订阅进度',
  subscriptions: '有效订阅', announcements: '公告', redeem_history: '兑换记录', channel_monitors: '渠道监控', payment_plans: '支付套餐', orders: '订单',
}
let suppliers = loadSuppliers()
let selectedId = suppliers[0]?.id || ''
let currentView = 'overview'
let editingId = ''
let challenge = ''
let toastTimer
const resultDatabase = openResultDatabase()

function loadSuppliers() {
  try { return JSON.parse(localStorage.getItem('supplier-console-profiles') || '[]') } catch { return [] }
}
function saveSuppliers() {
  const profiles = suppliers.map(({ result, ...supplier }) => supplier)
  localStorage.setItem('supplier-console-profiles', JSON.stringify(profiles))
}
function openResultDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sub2api-supplier-console', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('results', { keyPath: 'supplierId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function persistResult(supplierId, result) {
  const database = await resultDatabase
  const transaction = database.transaction('results', 'readwrite')
  transaction.objectStore('results').put({ supplierId, result })
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error) })
}
async function removePersistedResult(supplierId) {
  const database = await resultDatabase
  const transaction = database.transaction('results', 'readwrite')
  transaction.objectStore('results').delete(supplierId)
}
async function hydrateResults() {
  try {
    const database = await resultDatabase
    const transaction = database.transaction('results', 'readonly')
    const request = transaction.objectStore('results').getAll()
    const records = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    for (const record of records) {
      const supplier = suppliers.find((item) => item.id === record.supplierId)
      if (supplier) supplier.result = record.result
    }
    renderShell()
  } catch {
    showToast('历史聚合结果无法读取')
  }
}
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
function selectedSupplier() { return suppliers.find((supplier) => supplier.id === selectedId) }

function renderSupplierList() {
  elements.supplierCount.textContent = suppliers.length
  elements.supplierEmpty.hidden = suppliers.length > 0
  elements.exportAll.disabled = !suppliers.some((supplier) => supplier.result)
  elements.supplierList.innerHTML = suppliers.map((supplier) => {
    const state = supplier.result ? 'ready' : supplier.error ? 'error' : ''
    return `<button class="supplier-item ${supplier.id === selectedId ? 'active' : ''}" data-id="${escapeHtml(supplier.id)}" type="button">
      <span class="supplier-avatar">${escapeHtml(supplier.name.slice(0, 2).toUpperCase())}</span>
      <span class="supplier-meta"><strong>${escapeHtml(supplier.name)}</strong><span>${escapeHtml(new URL(supplier.baseUrl).host)}</span></span>
      <i class="supplier-state ${state}"></i>
    </button>`
  }).join('')
}

function renderShell() {
  renderSupplierList()
  const supplier = selectedSupplier()
  elements.welcome.hidden = Boolean(supplier)
  elements.dashboard.hidden = !supplier
  if (!supplier) return
  elements.dashboardName.textContent = supplier.name
  elements.dashboardUrl.textContent = `${supplier.baseUrl} · ${supplier.email}`
  elements.syncState.textContent = supplier.loading ? '同步中...' : supplier.error ? '同步失败' : supplier.result ? `更新于 ${formatDate(supplier.result.fetched_at)}` : '未同步'
  elements.lastRefresh.textContent = supplier.result ? `最后同步 ${formatDate(supplier.result.fetched_at)}` : '尚未同步'
  elements.dashboardEmpty.hidden = Boolean(supplier.result)
  elements.dashboardContent.hidden = !supplier.result
  if (supplier.result) renderDashboard(supplier.result)
}

function renderDashboard(result) {
  elements.tabs.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.view === currentView))
  const groups = itemsOf(result.resources.groups)
  const platforms = new Set(groups.map((group) => group.platform).filter(Boolean))
  const summary = result.summary
  elements.metricBalance.textContent = formatMoney(summary.balance)
  elements.metricUser.textContent = summary.username || '-'
  elements.metricGroups.textContent = summary.groups
  elements.metricPlatforms.textContent = `${platforms.size} 个平台`
  elements.metricKeys.textContent = summary.api_keys
  elements.metricActiveKeys.textContent = `${summary.active_api_keys} 个启用`
  const health = Math.round(summary.successful_resources / summary.total_resources * 100)
  elements.metricHealth.textContent = `${health}%`
  elements.metricResourceState.textContent = `${summary.successful_resources} / ${summary.total_resources} 项`
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
      <div class="kv-row"><span>邮箱</span><strong>${escapeHtml(profile.email || result.supplier.email)}</strong></div>
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

function renderView() {
  const result = selectedSupplier()?.result
  if (!result) return
  const renderers = { overview: renderOverview, groups: renderGroups, channels: renderChannels, usage: renderUsage, subscriptions: renderSubscriptions, raw: renderRaw }
  elements.viewContent.innerHTML = renderers[currentView](result)
}

function openDialog(supplier = null) {
  editingId = supplier?.id || ''
  challenge = ''
  elements.dialogTitle.textContent = supplier ? `同步 ${supplier.name}` : '添加供应商'
  elements.form.reset(); elements.formError.hidden = true; elements.twoFactor.hidden = true; elements.totpCode.required = false
  elements.supplierName.value = supplier?.name || ''; elements.baseUrl.value = supplier?.baseUrl || ''; elements.email.value = supplier?.email || ''
  elements.dialog.showModal(); setTimeout(() => (supplier ? elements.password : elements.supplierName).focus(), 0)
}
function closeDialog() { elements.dialog.close(); challenge = ''; elements.password.value = ''; elements.totpCode.value = '' }

async function collectSupplier(payload) {
  const response = await fetch('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const result = await response.json()
  if (!response.ok || (!result.ok && !result.requiresTwoFactor)) throw new Error(result.message || '同步失败')
  return result
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault(); elements.submit.disabled = true; elements.submit.textContent = '正在同步...'; elements.formError.hidden = true
  const payload = Object.fromEntries(new FormData(elements.form).entries())
  payload.supplierId = editingId || crypto.randomUUID(); payload.challenge = challenge
  try {
    const result = await collectSupplier(payload)
    if (result.requiresTwoFactor) {
      challenge = result.challenge; elements.twoFactor.hidden = false; elements.maskedEmail.textContent = result.maskedEmail || ''; elements.totpCode.required = true; elements.totpCode.focus(); return
    }
    const supplier = { id: payload.supplierId, name: result.supplier.name, baseUrl: result.supplier.base_url, email: result.supplier.email, result }
    const index = suppliers.findIndex((item) => item.id === supplier.id)
    if (index >= 0) suppliers[index] = supplier; else suppliers.push(supplier)
    selectedId = supplier.id; saveSuppliers(); await persistResult(supplier.id, result); closeDialog(); renderShell(); showToast(`已同步 ${supplier.name} 的 ${result.summary.successful_resources} 项数据`)
  } catch (error) { elements.formError.textContent = error.message || '同步失败'; elements.formError.hidden = false }
  finally { elements.submit.disabled = false; elements.submit.textContent = challenge ? '验证并同步' : '连接并同步' }
})

elements.supplierList.addEventListener('click', (event) => { const item = event.target.closest('[data-id]'); if (!item) return; selectedId = item.dataset.id; currentView = 'overview'; elements.search.value = ''; renderShell() })
elements.tabs.addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (!button) return; currentView = button.dataset.view; elements.tabs.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button)); elements.search.value = ''; renderView() })
elements.search.addEventListener('input', renderView)
$('#add-supplier').addEventListener('click', () => openDialog()); $('#welcome-add').addEventListener('click', () => openDialog()); $('#close-dialog').addEventListener('click', closeDialog)
$('#sync-current').addEventListener('click', () => openDialog(selectedSupplier())); $('#edit-current').addEventListener('click', () => openDialog(selectedSupplier()))
$('#remove-current').addEventListener('click', async () => { const supplier = selectedSupplier(); if (!supplier || !confirm(`删除供应商“${supplier.name}”？`)) return; suppliers = suppliers.filter((item) => item.id !== supplier.id); selectedId = suppliers[0]?.id || ''; saveSuppliers(); await removePersistedResult(supplier.id); renderShell() })
elements.togglePassword.addEventListener('click', () => { const visible = elements.password.type === 'text'; elements.password.type = visible ? 'password' : 'text'; elements.togglePassword.textContent = visible ? '查看' : '隐藏' })
$('#export-current').addEventListener('click', () => downloadJson(selectedSupplier()?.result, `${selectedSupplier()?.name || 'supplier'}-${new Date().toISOString().slice(0, 10)}.json`))
elements.exportAll.addEventListener('click', () => downloadJson({ exported_at: new Date().toISOString(), suppliers: suppliers.filter((item) => item.result).map((item) => item.result) }, `sub2api-suppliers-${new Date().toISOString().slice(0, 10)}.json`))
function downloadJson(data, filename) { if (!data) return; const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href); showToast('JSON 已导出') }

renderShell()
hydrateResults()
