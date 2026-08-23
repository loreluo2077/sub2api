#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.SUB2API_BASE_URL || '',
    email: process.env.SUB2API_EMAIL || '',
    password: process.env.SUB2API_PASSWORD || '',
    turnstileToken: process.env.SUB2API_TURNSTILE_TOKEN || '',
    tencentCaptchaTicket: process.env.SUB2API_TENCENT_CAPTCHA_TICKET || '',
    tencentCaptchaRandstr: process.env.SUB2API_TENCENT_CAPTCHA_RANDSTR || '',
    totpCode: process.env.SUB2API_TOTP_CODE || '',
    output: process.env.SUB2API_OUTPUT || '',
  }

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--base-url' && next) out.baseUrl = next
    else if (arg === '--email' && next) out.email = next
    else if (arg === '--password' && next) out.password = next
    else if (arg === '--turnstile-token' && next) out.turnstileToken = next
    else if (arg === '--tencent-captcha-ticket' && next) out.tencentCaptchaTicket = next
    else if (arg === '--tencent-captcha-randstr' && next) out.tencentCaptchaRandstr = next
    else if (arg === '--totp-code' && next) out.totpCode = next
    else if ((arg === '--output' || arg === '-o') && next) out.output = next
  }

  return out
}

function ensureBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  if (!value) {
    throw new Error('Missing base URL. Set SUB2API_BASE_URL or pass --base-url.')
  }
  if (/\/api\/v1$/i.test(value)) {
    return value
  }
  return `${value}/api/v1`
}

function redactedEmail(email) {
  const value = String(email || '').trim()
  const at = value.indexOf('@')
  if (at <= 1) return '***'
  return `${value[0]}***${value.slice(at - 1)}`
}

async function readJson(response) {
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message = body && typeof body === 'object'
      ? body.message || body.error || JSON.stringify(body)
      : text || response.statusText || 'request failed'
    throw new Error(`HTTP ${response.status}: ${message}`)
  }

  if (body && typeof body === 'object' && 'code' in body) {
    if (body.code !== 0) {
      throw new Error(body.message || `API error ${body.code}`)
    }
    return body.data
  }

  return body
}

async function apiGet(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })
  return readJson(response)
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
  return readJson(response)
}

async function login(apiBaseUrl, args) {
  const payload = {
    email: args.email,
    password: args.password,
  }

  if (args.turnstileToken) payload.turnstile_token = args.turnstileToken
  if (args.tencentCaptchaTicket) payload.tencent_captcha_ticket = args.tencentCaptchaTicket
  if (args.tencentCaptchaRandstr) payload.tencent_captcha_randstr = args.tencentCaptchaRandstr

  const result = await apiPost(`${apiBaseUrl}/auth/login`, payload)

  if (result && result.requires_2fa) {
    if (!args.totpCode) {
      throw new Error('Login requires 2FA. Re-run with --totp-code or SUB2API_TOTP_CODE.')
    }

    const second = await apiPost(`${apiBaseUrl}/auth/login/2fa`, {
      temp_token: result.temp_token,
      totp_code: args.totpCode,
    })

    return { auth: second, usedTwoFactor: true }
  }

  return { auth: result, usedTwoFactor: false }
}

function mergeGroups(groups, rates) {
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const customRate = rates && Object.prototype.hasOwnProperty.call(rates, group.id)
      ? rates[group.id]
      : null
    return {
      ...group,
      user_rate_multiplier: customRate,
      effective_rate_multiplier: customRate ?? group.rate_multiplier,
    }
  })
}

async function main() {
  const args = parseArgs(process.argv)
  const apiBaseUrl = ensureBaseUrl(args.baseUrl)

  if (!args.email || !args.password) {
    throw new Error('Missing credentials. Set SUB2API_EMAIL and SUB2API_PASSWORD, or pass --email/--password.')
  }

  const loginResult = await login(apiBaseUrl, args)
  const auth = loginResult.auth
  if (!auth || !auth.access_token) {
    throw new Error('Login did not return an access token.')
  }

  const [groups, rates] = await Promise.all([
    apiGet(`${apiBaseUrl}/groups/available`, auth.access_token),
    apiGet(`${apiBaseUrl}/groups/rates`, auth.access_token),
  ])

  const result = {
    source: {
      base_url: apiBaseUrl.replace(/\/api\/v1$/, ''),
      user: redactedEmail(args.email),
    },
    auth: {
      token_type: auth.token_type || 'Bearer',
      expires_in: auth.expires_in ?? null,
      two_factor: loginResult.usedTwoFactor,
    },
    groups: mergeGroups(groups, rates),
    rates: rates || {},
  }

  const json = `${JSON.stringify(result, null, 2)}\n`
  if (args.output) {
    await writeFile(args.output, json, 'utf8')
    process.stderr.write(`Wrote ${result.groups.length} groups to ${args.output}\n`)
  } else {
    process.stdout.write(json)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
