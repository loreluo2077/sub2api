#!/usr/bin/env node

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const host = '127.0.0.1'
const port = Number(process.env.GROUP_SYNC_PORT || 4178)
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url))
const databasePath = fileURLToPath(new URL('./data.db', import.meta.url))
const officialPricePath = fileURLToPath(new URL('../../backend/resources/model-pricing/model_prices_and_context_window.json', import.meta.url))
const maximumBodySize = 64 * 1024

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

// ---------- SQLite ----------
const db = new DatabaseSync(databasePath)
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('supplier','target')),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    access_token TEXT NOT NULL DEFAULT '',
    balance REAL,
    username TEXT DEFAULT '',
    fetched_at TEXT,
    rmb_per_usd REAL DEFAULT 7.0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)
// 兼容旧库：补充摘要列并清理已废弃的表
const siteColumns = new Set(db.prepare('PRAGMA table_info(sites)').all().map((c) => c.name))
if (!siteColumns.has('balance')) db.exec('ALTER TABLE sites ADD COLUMN balance REAL')
if (!siteColumns.has('username')) db.exec('ALTER TABLE sites ADD COLUMN username TEXT')
if (!siteColumns.has('fetched_at')) db.exec('ALTER TABLE sites ADD COLUMN fetched_at TEXT')
if (!siteColumns.has('rmb_per_usd')) db.exec('ALTER TABLE sites ADD COLUMN rmb_per_usd REAL DEFAULT 7.0')
if (!siteColumns.has('access_token')) db.exec("ALTER TABLE sites ADD COLUMN access_token TEXT DEFAULT ''")
db.exec('DROP TABLE IF EXISTS results')
db.exec('DROP TABLE IF EXISTS key_records')

function siteToDto(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    base_url: row.base_url,
    email: row.email,
    has_password: Boolean(row.password),
    has_token: Boolean(row.access_token),
    balance: row.balance,
    username: row.username,
    fetched_at: row.fetched_at,
    rmb_per_usd: normalizeRmbPerUsd(row.rmb_per_usd),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function normalizeRmbPerUsd(value) {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return number
  return 7.0
}

function dbGetSite(id) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id)
}
function dbListSites() {
  return db.prepare('SELECT * FROM sites ORDER BY created_at ASC').all()
}
function dbUpsertSite({ id, kind, name, base_url, email, password, access_token, rmb_per_usd }) {
  const now = new Date().toISOString()
  const existing = dbGetSite(id)
  const rate = rmb_per_usd !== undefined ? normalizeRmbPerUsd(rmb_per_usd) : (existing ? normalizeRmbPerUsd(existing.rmb_per_usd) : 7.0)
  const token = access_token !== undefined ? String(access_token) : (existing ? existing.access_token : '')
  if (existing) {
    db.prepare('UPDATE sites SET name = ?, base_url = ?, email = ?, password = ?, access_token = ?, rmb_per_usd = ?, updated_at = ? WHERE id = ?')
      .run(name, base_url, email, password, token, rate, now, id)
  } else {
    db.prepare('INSERT INTO sites (id, kind, name, base_url, email, password, access_token, rmb_per_usd, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, name, base_url, email, password, token, rate, now, now)
  }
  return dbGetSite(id)
}
function dbUpdateSite(id, fields) {
  const sets = []
  const values = []
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`)
    values.push(value)
  }
  if (!sets.length) return
  db.prepare(`UPDATE sites SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), id)
}
function dbSetSummary(id, { balance, username, fetchedAt }) {
  db.prepare('UPDATE sites SET balance = ?, username = ?, fetched_at = ?, updated_at = ? WHERE id = ?')
    .run(balance, username, fetchedAt, new Date().toISOString(), id)
}
function dbDeleteSite(id) {
  db.prepare('DELETE FROM sites WHERE id = ?').run(id)
}

// ---------- 官方价目表（本地文件，USD/每 token） ----------
let officialPriceMap = {}
try {
  const raw = await readFile(officialPricePath, 'utf8')
  const entries = JSON.parse(raw)
  for (const [name, entry] of Object.entries(entries)) {
    officialPriceMap[name.toLowerCase()] = {
      input: entry.input_cost_per_token != null ? entry.input_cost_per_token * 1_000_000 : null,
      output: entry.output_cost_per_token != null ? entry.output_cost_per_token * 1_000_000 : null,
      cacheWrite: entry.cache_creation_input_token_cost != null ? entry.cache_creation_input_token_cost * 1_000_000 : null,
      cacheRead: entry.cache_read_input_token_cost != null ? entry.cache_read_input_token_cost * 1_000_000 : null,
    }
  }
  console.log(`已加载官方价目表：${Object.keys(officialPriceMap).length} 个模型`)
} catch (error) {
  console.log(`官方价目表加载失败（将使用 model_plaza 数据）：${error?.message || error}`)
}

async function handleOfficialPrices(request, response) {
  return sendJson(response, 200, { ok: true, prices: officialPriceMap })
}

// ---------- 登录会话（向导两阶段用） ----------
const loginSessions = new Map()
const sessionTtlMs = 30 * 60 * 1000
function setLoginSession(session) {
  const sessionId = crypto.randomUUID()
  loginSessions.set(sessionId, { ...session, createdAt: Date.now() })
  return sessionId
}
function getLoginSession(sessionId) {
  const session = loginSessions.get(sessionId || '')
  if (!session) return null
  if (Date.now() - session.createdAt > sessionTtlMs) {
    loginSessions.delete(sessionId)
    return null
  }
  return session
}

// ---------- 基础工具 ----------
function normalizeBaseUrl(raw) {
  const candidate = String(raw || '').trim().replace(/\/+$/, '')
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('目标地址仅支持 HTTP 或 HTTPS')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/i, '')
  return url.toString().replace(/\/$/, '')
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

async function readRequestBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBodySize) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function requestApi(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`目标站返回了非 JSON 内容（HTTP ${response.status}）`)
    }
    if (!response.ok || (body && typeof body === 'object' && 'code' in body && body.code !== 0)) {
      throw new Error(body?.message || body?.error || `目标站请求失败（HTTP ${response.status}）`)
    }
    return body && typeof body === 'object' && 'code' in body ? body.data : body
  } finally {
    clearTimeout(timeout)
  }
}

function maskSecret(value) {
  const secret = String(value || '')
  if (secret.length <= 10) return '***'
  return `${secret.slice(0, 5)}...${secret.slice(-4)}`
}

async function performLogin(baseUrl, email, password) {
  if (!email || !password) throw new Error('请填写邮箱和密码')
  const auth = await requestApi(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!auth?.access_token) throw new Error('登录成功，但目标站没有返回访问令牌')
  return auth.access_token
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
}

// 解析凭据：优先使用站点库中的账号密码/token，其次使用请求内联传入的
function resolveCredentials(input) {
  if (input.siteId) {
    const site = dbGetSite(String(input.siteId))
    if (!site) throw new Error('站点不存在，请先保存站点')
    return {
      site,
      baseUrl: normalizeBaseUrl(site.base_url),
      email: String(input.email || site.email || '').trim(),
      password: String(input.password || site.password || ''),
      accessToken: String(input.access_token || site.access_token || ''),
    }
  }
  return {
    site: null,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    email: String(input.email || '').trim(),
    password: String(input.password || ''),
    accessToken: String(input.access_token || ''),
  }
}

// 获取鉴权头：优先用 access_token，其次用用户名密码登录
async function resolveAuthHeaders(credentials) {
  if (credentials.accessToken) {
    return authHeaders(credentials.accessToken)
  }
  const accessToken = await performLogin(credentials.baseUrl, credentials.email, credentials.password)
  return authHeaders(accessToken)
}

// 登录后若有新的邮箱/密码/token，则回写站点库
function persistCredentials(siteId, input, baseUrl, email, password, accessToken) {
  if (!siteId) return
  const updates = {}
  const name = String(input.name || input.supplierName || '').trim()
  if (name) updates.name = name
  if (input.baseUrl) updates.base_url = normalizeBaseUrl(input.baseUrl)
  if (email) updates.email = email
  if (password) updates.password = password
  if (accessToken) updates.access_token = accessToken
  if (Object.keys(updates).length) dbUpdateSite(siteId, updates)
}

async function fetchAllApiKeys(baseUrl, headers) {
  const keys = []
  const pageSize = 100
  for (let page = 1; page <= 50; page += 1) {
    const data = await requestApi(`${baseUrl}/api/v1/keys?page=${page}&page_size=${pageSize}`, { headers })
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
    keys.push(...items)
    const total = data?.total != null ? Number(data.total) : items.length
    const fetched = page * pageSize
    if (!items.length || fetched >= total) break
  }
  return keys
}

function sanitizeApiKeys(value) {
  if (!value || typeof value !== 'object') return value
  const items = Array.isArray(value) ? value : Array.isArray(value.items) ? value.items : []
  const sanitized = items.map((item) => ({
    ...item,
    key: maskSecret(item.key),
    ip_whitelist: undefined,
    ip_blacklist: undefined,
  }))
  return Array.isArray(value) ? sanitized : { ...value, items: sanitized }
}

async function collectResource(baseUrl, headers, definition) {
  try {
    const data = await requestApi(`${baseUrl}${definition.path}`, { headers })
    return { status: 'ok', data: definition.sanitize ? definition.sanitize(data) : data }
  } catch (error) {
    return {
      status: definition.optional ? 'unavailable' : 'error',
      message: error?.name === 'AbortError' ? '请求超时' : error?.message || '请求失败',
    }
  }
}

function mergeGroupRates(groupsResource, ratesResource) {
  const groups = Array.isArray(groupsResource?.data) ? groupsResource.data : []
  const rates = ratesResource?.data && typeof ratesResource.data === 'object' ? ratesResource.data : {}
  return groups.map((group) => {
    const customRate = Object.prototype.hasOwnProperty.call(rates, group.id) ? rates[group.id] : null
    return {
      ...group,
      user_rate_multiplier: customRate,
      effective_rate_multiplier: customRate ?? group.rate_multiplier,
    }
  })
}

const collectDefinitions = [
  { key: 'settings', path: '/api/v1/settings/public', optional: true },
  { key: 'current_user', path: '/api/v1/auth/me' },
  { key: 'profile', path: '/api/v1/user/profile' },
  { key: 'platform_quotas', path: '/api/v1/user/platform-quotas', optional: true },
  { key: 'affiliate', path: '/api/v1/user/aff', optional: true },
  { key: 'api_keys', path: '/api/v1/keys?page=1&page_size=100', sanitize: sanitizeApiKeys },
  { key: 'groups', path: '/api/v1/groups/available' },
  { key: 'group_rates', path: '/api/v1/groups/rates' },
  { key: 'channels', path: '/api/v1/channels/available', optional: true },
  { key: 'model_plaza', path: '/api/v1/model-plaza', optional: true },
  { key: 'usage_snapshot', path: '/api/v1/usage/dashboard/snapshot-v2?include_trend=true&include_model_stats=true&include_group_stats=true', optional: true },
  { key: 'usage_stats', path: '/api/v1/usage/dashboard/stats', optional: true },
  { key: 'usage_logs', path: '/api/v1/usage?page=1&page_size=100&sort_by=created_at&sort_order=desc', optional: true },
  { key: 'usage_logs_page2', path: '/api/v1/usage?page=2&page_size=100&sort_by=created_at&sort_order=desc', optional: true },
  { key: 'subscription_summary', path: '/api/v1/subscriptions/summary', optional: true },
  { key: 'subscription_progress', path: '/api/v1/subscriptions/progress', optional: true },
  { key: 'subscriptions', path: '/api/v1/subscriptions/active', optional: true },
  { key: 'announcements', path: '/api/v1/announcements?page=1&page_size=50', optional: true },
  { key: 'redeem_history', path: '/api/v1/redeem/history', optional: true },
  { key: 'channel_monitors', path: '/api/v1/channel-monitors', optional: true },
  { key: 'payment_plans', path: '/api/v1/payment/plans', optional: true },
  { key: 'orders', path: '/api/v1/payment/orders/my?page=1&page_size=50', optional: true },
]

// ---------- 站点 CRUD ----------
async function handleSites(request, response) {
  try {
    const method = request.method
    const url = new URL(request.url, `http://${request.headers.host || host}`)
    const parts = url.pathname.split('/').filter(Boolean)

    if (method === 'GET' && parts.length === 2) {
      const sites = dbListSites().map(siteToDto)
      return sendJson(response, 200, { ok: true, sites })
    }

    if (method === 'POST' && parts.length === 2) {
      const input = await readRequestBody(request)
      const id = crypto.randomUUID()
      dbUpsertSite({
        id,
        kind: input.kind === 'target' ? 'target' : 'supplier',
        name: String(input.name || '').trim() || '未命名站点',
        base_url: normalizeBaseUrl(input.baseUrl),
        email: String(input.email || '').trim(),
        password: String(input.password || ''),
        access_token: input.access_token,
        rmb_per_usd: input.rmb_per_usd,
      })
      return sendJson(response, 200, { ok: true, site: siteToDto(dbGetSite(id)) })
    }

    if (method === 'PUT' && parts.length === 3) {
      const id = parts[2]
      if (!dbGetSite(id)) throw new Error('站点不存在')
      const input = await readRequestBody(request)
      const updates = {}
      if (input.name !== undefined) updates.name = String(input.name).trim()
      if (input.kind) updates.kind = input.kind === 'target' ? 'target' : 'supplier'
      if (input.baseUrl !== undefined) updates.base_url = normalizeBaseUrl(input.baseUrl)
      if (input.email !== undefined) updates.email = String(input.email).trim()
      if (input.password !== undefined) updates.password = String(input.password)
      if (input.access_token !== undefined) updates.access_token = String(input.access_token)
      if (input.rmb_per_usd !== undefined) updates.rmb_per_usd = normalizeRmbPerUsd(input.rmb_per_usd)
      dbUpdateSite(id, updates)
      return sendJson(response, 200, { ok: true, site: siteToDto(dbGetSite(id)) })
    }

    if (method === 'DELETE' && parts.length === 3) {
      const id = parts[2]
      if (!dbGetSite(id)) throw new Error('站点不存在')
      dbDeleteSite(id)
      return sendJson(response, 200, { ok: true })
    }

    sendJson(response, 404, { ok: false, message: '接口不存在' })
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error?.message || '站点操作失败' })
  }
}

// ---------- 同步采集（只持久化账户摘要，全量数据实时返回） ----------
async function handleCollect(request, response) {
  try {
    const input = await readRequestBody(request)
    const credentials = resolveCredentials(input)
    const { site, baseUrl, email, password, accessToken } = credentials
    const headers = await resolveAuthHeaders(credentials)

    const collected = await Promise.all(collectDefinitions.map(async (definition) => [
      definition.key,
      await collectResource(baseUrl, headers, definition),
    ]))
    const resources = Object.fromEntries(collected)
    const mergedGroups = mergeGroupRates(resources.groups, resources.group_rates)
    if (resources.groups.status === 'ok') resources.groups.data = mergedGroups

    const user = resources.profile.data || resources.current_user.data || {}
    const apiKeyData = resources.api_keys.data
    const apiKeys = Array.isArray(apiKeyData) ? apiKeyData : apiKeyData?.items || []
    const successfulResources = Object.values(resources).filter((resource) => resource.status === 'ok').length

    const siteId = site?.id || input.siteId || crypto.randomUUID()
    const name = site ? site.name : (String(input.name || input.supplierName || '').trim() || new URL(baseUrl).hostname)
    const kind = input.kind === 'target' ? 'target' : (site?.kind || 'supplier')

    dbUpsertSite({ id: siteId, kind, name, base_url: baseUrl, email, password, access_token: accessToken })
    persistCredentials(siteId, input, baseUrl, email, password, accessToken)

    const fetchedAt = new Date().toISOString()
    const summary = {
      balance: user.balance ?? null,
      username: user.username || user.name || email,
      groups: mergedGroups.length,
      api_keys: apiKeys.length,
      active_api_keys: apiKeys.filter((key) => key.status === 'active').length,
      successful_resources: successfulResources,
      total_resources: collectDefinitions.length,
    }
    dbSetSummary(siteId, { balance: summary.balance, username: summary.username, fetchedAt })

    sendJson(response, 200, {
      ok: true,
      site: siteToDto(dbGetSite(siteId)),
      fetched_at: fetchedAt,
      summary,
      resources,
    })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接目标站超时' : error?.message || '同步失败'
    sendJson(response, 400, { ok: false, message })
  }
}

// ---------- 分组建 Key（两阶段） ----------
async function handlePrepareGroupKeys(request, response) {
  try {
    const input = await readRequestBody(request)

    // 阶段二：使用已登录会话，为选中的分组创建 Key
    const session = getLoginSession(input.sessionId)
    if (session && Array.isArray(input.selectedGroupIds) && input.selectedGroupIds.length > 0) {
      const headers = authHeaders(session.accessToken)
      const existingKeys = await fetchAllApiKeys(session.baseUrl, headers)
      const prefix = String(input.keyPrefix || '').trim()
      const results = []
      for (const group of session.groups) {
        if (!input.selectedGroupIds.includes(group.id)) continue
        const name = `${prefix}${group.name}`
        const existing = existingKeys.find((key) => key.group_id === group.id && key.key)
        if (existing) {
          results.push({ groupId: group.id, groupName: group.name, name: existing.name || name, key: existing.key, mode: 'existing' })
          continue
        }
        try {
          const created = await requestApi(`${session.baseUrl}/api/v1/keys`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, group_id: group.id }),
          })
          results.push({ groupId: group.id, groupName: group.name, name, key: created?.key || '', mode: 'created' })
        } catch (error) {
          results.push({ groupId: group.id, groupName: group.name, name, key: '', mode: 'failed', error: error?.message || '创建失败' })
        }
      }
      return sendJson(response, 200, { ok: true, phase: 'create', groups: results })
    }

    // 阶段一：登录并获取分组（尚未创建 Key）
    const credentials = resolveCredentials(input)
    const { site, baseUrl, email, password, accessToken } = credentials
    const headers = await resolveAuthHeaders(credentials)
    const groupsData = await requestApi(`${baseUrl}/api/v1/groups/available`, { headers })
    const groups = Array.isArray(groupsData) ? groupsData : groupsData?.items || []
    const existingKeys = await fetchAllApiKeys(baseUrl, headers)
    const enriched = groups.map((group) => ({
      id: group.id,
      name: group.name,
      platform: group.platform,
      is_exclusive: group.is_exclusive,
      subscription_type: group.subscription_type,
      has_key: existingKeys.some((key) => key.group_id === group.id && key.key),
    }))
    const sessionId = setLoginSession({
      siteId: site?.id || input.siteId || '',
      baseUrl,
      accessToken,
      email,
      groups: enriched,
    })
    if (site) persistCredentials(site.id, input, baseUrl, email, password, accessToken)

    sendJson(response, 200, {
      ok: true,
      phase: 'login',
      sessionId,
      site: site ? siteToDto(site) : null,
      groups: enriched,
    })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接上游超时' : error?.message || '准备 Key 失败'
    sendJson(response, 400, { ok: false, message })
  }
}

// ---------- 实时拉取上游 Keys（供导入对话框） ----------
async function handleListKeys(request, response) {
  try {
    const input = await readRequestBody(request)
    const credentials = resolveCredentials(input)
    const { baseUrl } = credentials
    const headers = await resolveAuthHeaders(credentials)
    const keys = await fetchAllApiKeys(baseUrl, headers)

    let groupNames = new Map()
    try {
      const groupsData = await requestApi(`${baseUrl}/api/v1/groups/available`, { headers })
      const groups = Array.isArray(groupsData) ? groupsData : groupsData?.items || []
      groupNames = new Map(groups.map((group) => [group.id, group.name]))
    } catch {
      // 分组名非必需，拉不到就用空串
    }

    sendJson(response, 200, {
      ok: true,
      keys: keys.map((key) => ({
        name: key.name,
        key: key.key,
        group_id: key.group_id,
        group_name: groupNames.get(key.group_id) || '',
        status: key.status,
      })),
    })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接上游超时' : error?.message || '拉取 Keys 失败'
    sendJson(response, 400, { ok: false, message })
  }
}

// ---------- 导入 Key 到目标站 ----------
async function handleImportKeys(request, response) {
  try {
    const input = await readRequestBody(request)
    const credentials = resolveCredentials(input)
    const { site, baseUrl, email, password, accessToken } = credentials
    const keysToImport = Array.isArray(input.keys) ? input.keys.filter((item) => item?.key) : []
    if (!keysToImport.length) throw new Error('没有可导入的 Key')

    const headers = await resolveAuthHeaders(credentials)

    const existingKeys = await fetchAllApiKeys(baseUrl, headers)
    const existingSet = new Set(existingKeys.map((item) => item.key))

    if (site) persistCredentials(site.id, input, baseUrl, email, password, accessToken)

    const results = []
    for (const item of keysToImport) {
      if (existingSet.has(item.key)) {
        results.push({ name: item.name, key: item.key, status: 'skipped' })
        continue
      }
      try {
        await requestApi(`${baseUrl}/api/v1/keys`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: item.name, custom_key: item.key }),
        })
        results.push({ name: item.name, key: item.key, status: 'imported' })
      } catch (error) {
        results.push({ name: item.name, key: item.key, status: 'failed', error: error?.message || '导入失败' })
      }
    }

    sendJson(response, 200, {
      ok: true,
      target: site ? siteToDto(site) : { name: String(input.targetName || '').trim() || new URL(baseUrl).hostname, base_url: baseUrl, email },
      results,
    })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接目标站超时' : error?.message || '导入 Key 失败'
    sendJson(response, 400, { ok: false, message })
  }
}

// ---------- 导入上游账号到目标站账号管理 ----------
async function handleImportAccounts(request, response) {
  try {
    const input = await readRequestBody(request)
    const credentials = resolveCredentials(input)
    const { site, baseUrl, email, password, accessToken } = credentials
    const keysToImport = Array.isArray(input.keys) ? input.keys.filter((item) => item?.key) : []
    if (!keysToImport.length) throw new Error('没有可导入的 Key')

    const sourceSite = input.sourceSiteId ? dbGetSite(String(input.sourceSiteId)) : null
    if (!sourceSite) throw new Error('来源上游站点不存在，请先保存上游站点')
    const sourceName = String(sourceSite.name || '').trim()
    const sourceBaseUrl = normalizeBaseUrl(sourceSite.base_url)

    const headers = await resolveAuthHeaders(credentials)

    // 拉取目标站已有账号名做查重（接口对凭证脱敏，只能按账号名去重）
    const existingNames = new Set()
    const pageSize = 100
    for (let page = 1; page <= 50; page += 1) {
      const data = await requestApi(`${baseUrl}/api/v1/admin/accounts?page=${page}&page_size=${pageSize}`, { headers })
      const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
      for (const account of items) {
        if (account && account.name) existingNames.add(String(account.name))
      }
      const total = data?.total != null ? Number(data.total) : items.length
      if (!items.length || page * pageSize >= total) break
    }

    if (site) persistCredentials(site.id, input, baseUrl, email, password, accessToken)

    const results = []
    for (const item of keysToImport) {
      const key = item.key
      const accountName = sourceName ? `${sourceName}-${String(item.name || '').trim()}` : String(item.name || key)
      if (existingNames.has(accountName)) {
        results.push({ name: accountName, key, status: 'skipped' })
        continue
      }
      try {
        // 先用上游 Key 同步上游支持的模型（目标站会请求上游 GET /v1/models）
        const synced = await requestApi(`${baseUrl}/api/v1/admin/accounts/models/sync-upstream-preview`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'openai', type: 'apikey', base_url: sourceBaseUrl, api_key: key }),
        })
        const models = Array.isArray(synced?.models)
          ? synced.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim())
          : []
        const modelMapping = {}
        for (const model of models) modelMapping[model] = model

        await requestApi(`${baseUrl}/api/v1/admin/accounts`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: accountName,
            platform: 'openai',
            type: 'apikey',
            credentials: {
              base_url: sourceBaseUrl,
              api_key: key,
              model_mapping: Object.keys(modelMapping).length ? modelMapping : undefined,
              pool_mode: true,
              pool_mode_retry_count: 3,
              pool_mode_retry_status_codes: [401, 403, 429],
            },
            group_ids: [],
          }),
        })
        results.push({ name: accountName, key, models_count: models.length, status: 'imported' })
      } catch (error) {
        results.push({ name: accountName, key, status: 'failed', error: error?.message || '导入失败' })
      }
    }

    sendJson(response, 200, {
      ok: true,
      target: site ? siteToDto(site) : { name: String(input.targetName || '').trim() || new URL(baseUrl).hostname, base_url: baseUrl, email },
      source: { name: sourceName, base_url: sourceBaseUrl },
      results,
    })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接目标站超时' : error?.message || '导入账号失败'
    sendJson(response, 400, { ok: false, message })
  }
}

// ---------- 测试登录/凭据 ----------
async function handleTestLogin(request, response) {
  try {
    const input = await readRequestBody(request)
    const credentials = resolveCredentials(input)
    const headers = await resolveAuthHeaders(credentials)
    // 实际调用受保护接口验证 token/登录是否有效
    await requestApi(`${credentials.baseUrl}/api/v1/auth/me`, { headers })
    sendJson(response, 200, { ok: true, message: '连接成功' })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接目标站超时' : error?.message || '连接失败'
    sendJson(response, 200, { ok: false, message })
  }
}

// ---------- 静态文件 ----------
async function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host || host}`).pathname
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  if (relativePath === 'favicon.ico') {
    response.writeHead(204)
    return response.end()
  }
  if (!['index.html', 'styles.css', 'app.js'].includes(relativePath)) {
    response.writeHead(404)
    return response.end('Not found')
  }
  const filePath = join(publicDirectory, relativePath)
  const content = await readFile(filePath)
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(content)
}

// ---------- 路由 ----------
const server = createServer(async (request, response) => {
  try {
    const method = request.method
    const pathname = new URL(request.url, `http://${request.headers.host || host}`).pathname

    if (pathname === '/api/sites' || pathname.startsWith('/api/sites/')) return handleSites(request, response)

    if (method === 'GET' && pathname === '/api/official-prices') return handleOfficialPrices(request, response)

    if (method === 'POST') {
      const routes = {
        '/api/collect': handleCollect,
        '/api/sync': handleCollect,
        '/api/prepare-group-keys': handlePrepareGroupKeys,
        '/api/list-keys': handleListKeys,
        '/api/import-keys': handleImportKeys,
        '/api/import-accounts': handleImportAccounts,
        '/api/test-login': handleTestLogin,
      }
      const handler = routes[pathname]
      if (handler) return handler(request, response)
    }

    if (method === 'GET') {
      try {
        return await serveStatic(request, response)
      } catch {
        response.writeHead(500)
        return response.end('Unable to load application')
      }
    }

    response.writeHead(405)
    response.end('Method not allowed')
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error?.message || '服务器错误' })
  }
})

server.listen(port, host, () => {
  console.log(`Sub2API 分组同步工具已启动：http://${host}:${port}`)
})
