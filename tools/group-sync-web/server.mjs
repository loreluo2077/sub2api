#!/usr/bin/env node

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const host = '127.0.0.1'
const port = Number(process.env.GROUP_SYNC_PORT || 4178)
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url))
const maximumBodySize = 64 * 1024

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

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

async function handleCollect(request, response) {
  try {
    const input = await readRequestBody(request)
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const email = String(input.email || '').trim()
    const password = String(input.password || '')
    if (!email || (!password && !input.challenge)) throw new Error('请填写邮箱和密码')

    const loginPayload = { email, password }
    if (input.turnstileToken) loginPayload.turnstile_token = String(input.turnstileToken)
    if (input.tencentCaptchaTicket) loginPayload.tencent_captcha_ticket = String(input.tencentCaptchaTicket)
    if (input.tencentCaptchaRandstr) loginPayload.tencent_captcha_randstr = String(input.tencentCaptchaRandstr)

    let auth
    if (input.challenge && input.totpCode) {
      auth = await requestApi(`${baseUrl}/api/v1/auth/login/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ temp_token: input.challenge, totp_code: String(input.totpCode) }),
      })
    } else {
      auth = await requestApi(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(loginPayload),
      })
    }

    if (auth?.requires_2fa) {
      if (!input.totpCode) {
        return sendJson(response, 200, {
          ok: false,
          requiresTwoFactor: true,
          challenge: auth.temp_token,
          maskedEmail: auth.user_email_masked || '',
        })
      }
      throw new Error('两步验证状态无效，请重新登录')
    }

    if (!auth?.access_token) throw new Error('登录成功，但目标站没有返回访问令牌')
    const headers = { Authorization: `Bearer ${auth.access_token}`, Accept: 'application/json' }
    const definitions = [
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
      { key: 'subscription_summary', path: '/api/v1/subscriptions/summary', optional: true },
      { key: 'subscription_progress', path: '/api/v1/subscriptions/progress', optional: true },
      { key: 'subscriptions', path: '/api/v1/subscriptions/active', optional: true },
      { key: 'announcements', path: '/api/v1/announcements?page=1&page_size=50', optional: true },
      { key: 'redeem_history', path: '/api/v1/redeem/history', optional: true },
      { key: 'channel_monitors', path: '/api/v1/channel-monitors', optional: true },
      { key: 'payment_plans', path: '/api/v1/payment/plans', optional: true },
      { key: 'orders', path: '/api/v1/payment/orders/my?page=1&page_size=50', optional: true },
    ]
    const collected = await Promise.all(definitions.map(async (definition) => [
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

    sendJson(response, 200, {
      ok: true,
      supplier: {
        id: String(input.supplierId || ''),
        name: String(input.supplierName || '').trim() || new URL(baseUrl).hostname,
        base_url: baseUrl,
        email,
      },
      fetched_at: new Date().toISOString(),
      summary: {
        balance: user.balance ?? null,
        username: user.username || user.name || email,
        groups: mergedGroups.length,
        api_keys: apiKeys.length,
        active_api_keys: apiKeys.filter((key) => key.status === 'active').length,
        successful_resources: successfulResources,
        total_resources: definitions.length,
      },
      resources,
    })
  } catch (error) {
    const message = error?.name === 'AbortError' ? '连接目标站超时' : error?.message || '同步失败'
    sendJson(response, 400, { ok: false, message })
  }
}

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

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && ['/api/collect', '/api/sync'].includes(request.url)) return handleCollect(request, response)
  if (request.method === 'GET') {
    try {
      return await serveStatic(request, response)
    } catch {
      response.writeHead(500)
      return response.end('Unable to load application')
    }
  }
  response.writeHead(405)
  response.end('Method not allowed')
})

server.listen(port, host, () => {
  console.log(`Sub2API 分组同步工具已启动：http://${host}:${port}`)
})
