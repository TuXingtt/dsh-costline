// dsh-costline — host half.
//
// Two independent sources of truth, both served on GET /dsh-costline/summary?sessionId=<id>:
//
//   official  — REAL spend, derived from the official wallet balances sampled once a minute
//               (API key wallet via GET https://api.deepseek.com/user/balance, signed-in
//               account wallet via the account platform). A day's spend = first sample
//               + credits − last sample, so top-ups never read as negative usage.
//   local     — token estimate folded from session events, priced with the official price
//               table, refreshed hourly from api-docs.deepseek.com when reachable.
//
// Provider buckets: deepseek-official → api, deepseek-account → account, anything else → other.
// Ledger file: $DSH_HOME/storages/dsh-costline-ledger.json (local days + official days + prices).

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-costline'
export const inject = ['webServer']

const BUILTIN_PRICES = {
  flash: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1 },
  pro: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 4.5 },
}

const PRICING_PAGE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const PRICE_TTL_MS = 60 * 60 * 1000
const BALANCE_TTL_MS = 60 * 1000

const WEEKDAYS = { Mon: true, Tue: true, Wed: true, Thu: true, Fri: true }

/** Beijing wall-clock peak test for one epoch millisecond. */
export function isPeak(atMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(atMs))
  const get = (type) => parts.find((p) => p.type === type)?.value
  if (!WEEKDAYS[get('weekday')]) return false
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const minutes = hour * 60 + minute
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** Per-1M prices for one model at one instant. */
export function priceAt(model, atMs, table = BUILTIN_PRICES) {
  const id = String(model || '').toLowerCase()
  const base = /pro/.test(id) ? table.pro : table.flash
  const factor = isPeak(atMs) ? 2 : 1
  return {
    input: base.input * factor,
    output: base.output * factor,
    cacheRead: base.cacheRead * factor,
    cacheWrite: base.cacheWrite * factor,
  }
}

export function bucketOf(provider) {
  if (provider === 'deepseek-official') return 'api'
  if (provider === 'deepseek-account') return 'account'
  return 'other'
}

function emptyBucket() {
  return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
}

function addInto(target, source) {
  target.cost += source.cost
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.calls += source.calls
}

function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function monthKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** Monday-based week start, as a YYYY-MM-DD key. */
function weekStartKey(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return dayKey(date.getTime())
}

function ledgerPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-costline-ledger.json')
}

/**
 * Day-start balance borrowed from the local balance bookkeeping another widget keeps
 * (`<DSH_HOME>/.dshw-usage.json`: today's spend + current balance). Used only to seed the
 * FIRST day this plugin ever runs, so "today" is not short by everything before install.
 * Returns null when the file is missing, stale, or unreadable.
 */
function seedFromExternalBookkeeping(now = Date.now()) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const raw = JSON.parse(readFileSync(join(home, '.dshw-usage.json'), 'utf8'))
    if (raw?.date !== dayKey(now)) return null
    const usage = Number(raw.todayUsage)
    const last = Number(raw.lastBalance)
    if (!Number.isFinite(usage) || !Number.isFinite(last)) return null
    return { api: last + usage, account: null }
  } catch {
    return null
  }
}

function emptyOfficialSide() {
  return { first: null, last: null, credit: 0 }
}

function officialSpend(side) {
  if (!side || side.first === null || side.last === null) return null
  const spend = side.first + side.credit - side.last
  return spend > 0 ? spend : 0
}

/** A session log is a concatenation of zstd frames; decode every frame. */
function decodeSessionLog(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const slice = buffer.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buffer.length)
    try {
      text += zstdDecompressSync(slice).toString('utf8')
    } catch {
      /* a truncated tail frame is normal for the live session */
    }
  }
  return text
}

/**
 * Rebuild the local (own-usage) buckets from every session log under
 * `<DSH_HOME>/sessions`. This is what makes "today" cover the whole day instead of
 * "since the plugin was installed": the logs carry the exact per-step usage the
 * host itself recorded, with the provider/model/time of each step.
 * Seq-deduped against live events, so running it twice never double counts.
 */
export function backfillFromSessions(ledger, home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) files.push(full)
    }
  }
  walk(join(home, 'sessions'))

  let steps = 0
  let touched = 0
  for (const file of files) {
    const sessionId = basename(dirname(file))
    let text
    try {
      text = decodeSessionLog(file)
    } catch {
      continue
    }
    let counted = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (!usage) continue
      const source = event.data?.message?.source || {}
      ledger.record(sessionId, {
        provider: source.provider || 'unknown',
        model: source.model || '',
        usage,
        atMs: event.time ?? Date.now(),
        seq: event.seq,
      })
      steps++
      counted++
    }
    if (counted > 0) touched++
  }
  return { files: files.length, sessions: touched, steps }
}

/** Durable local + official day buckets, plus the price table state. */
export function createLedger(file = ledgerPath()) {
  let days = {}
  let official = {}
  let prices = { table: BUILTIN_PRICES, source: 'builtin', at: 0 }
  let carry = null
  let seen = {}
  let version = 0
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    version = Number(parsed?.version) || 0
    if (parsed && typeof parsed.days === 'object' && parsed.days) days = parsed.days
    if (parsed && typeof parsed.official === 'object' && parsed.official) official = parsed.official
    if (parsed && parsed.prices && parsed.prices.table) prices = parsed.prices
    if (parsed && parsed.carry) carry = parsed.carry
    if (parsed && typeof parsed.seen === 'object' && parsed.seen) seen = parsed.seen
  } catch {
    /* first run / unreadable: start empty */
  }
  // v4 rebuilds the local buckets from the session logs (seq-deduped), so a ledger
  // written by an older version would double count. Drop only the local side.
  if (version < 4) days = {}

  const sessions = new Map()
  let flushTimer
  let dirty = false

  function flush() {
    if (!dirty) return
    dirty = false
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 4, days, official, prices, carry, seen }))
      renameSync(tmp, file)
    } catch {
      /* disk problems must never break the turn */
    }
  }

  function scheduleFlush() {
    dirty = true
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush()
    }, 400)
    flushTimer.unref?.()
  }

  function priceTable() {
    return prices.table || BUILTIN_PRICES
  }

  function setPrices(table, source) {
    prices = { table, source, at: Date.now() }
    scheduleFlush()
  }

  function record(sessionId, { provider, model, usage, atMs, seq }) {
    // Seq dedupe: the same step can arrive live and again from a session-log backfill.
    if (typeof seq === 'number') {
      const highest = seen[sessionId]
      if (typeof highest === 'number' && seq <= highest) return 0
      seen[sessionId] = seq
    }
    const bucket = bucketOf(provider)
    const price = priceAt(model, atMs, priceTable())
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    const cost =
      (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6

    const key = dayKey(atMs)
    const day = days[key] || (days[key] = { api: emptyBucket(), account: emptyBucket(), other: emptyBucket() })
    const target = day[bucket] || (day[bucket] = emptyBucket())
    target.cost += cost
    target.input += input
    target.output += output
    target.cacheRead += cacheRead
    target.cacheWrite += cacheWrite
    target.calls += 1
    scheduleFlush()

    let session = sessions.get(sessionId)
    if (!session) {
      session = { providers: {}, models: {}, updatedAt: 0 }
      sessions.set(sessionId, session)
    }
    const sessionBucket = session.providers[bucket] || (session.providers[bucket] = emptyBucket())
    addInto(sessionBucket, { cost, input, output, cacheRead, cacheWrite, calls: 1 })
    const modelKey = String(model || 'unknown')
    session.models[modelKey] = (session.models[modelKey] || 0) + cost
    session.updatedAt = atMs
    return cost
  }

  /** One balance sample per channel: opens the day, counts top-ups as credit, moves `last`. */
  function sampleBalances(sample, atMs) {
    const key = dayKey(atMs)
    const day = official[key] || (official[key] = { api: emptyOfficialSide(), account: emptyOfficialSide() })
    for (const channel of ['api', 'account']) {
      const value = sample?.[channel]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const side = day[channel] || (day[channel] = emptyOfficialSide())
      if (side.first === null) side.first = value
      if (side.last !== null && value > side.last) side.credit += value - side.last
      side.last = value
      carry = { date: key, api: day.api.last, account: day.account.last }
    }
    scheduleFlush()
  }

  /**
   * Seed today's day-start baseline so "today" covers the whole day, not just the
   * time since this plugin was installed.
   *
   * Priority:
   *   1. a sample carried over from a previous day (the process was running at midnight
   *      or was restarted later that day — the last known balance is the day-start one);
   *   2. the local balance bookkeeping file another widget already keeps (same machine,
   *      same wallets), so the first run on a fresh plugin does not start from zero;
   *   3. today's first real sample (partial coverage, nothing better exists).
   */
  function bootstrap(now = Date.now()) {
    const key = dayKey(now)
    const seed = seedFromExternalBookkeeping(now)
    const existing = official[key]
    if (existing) {
      for (const channel of ['api', 'account']) {
        const side = existing[channel]
        if (!side) continue
        if (side.first === null && carry && carry.date !== key && typeof carry[channel] === 'number') {
          side.first = carry[channel]
          side.last = side.last ?? carry[channel]
        }
      }
      // The plugin was installed mid-day: our first sample is the install-time balance,
      // so the real day-start baseline can only come from external bookkeeping. Accept it
      // only when it implies MORE spending than we have recorded (never lowers a day).
      const apiSide = existing.api
      if (
        apiSide &&
        seed &&
        typeof seed.api === 'number' &&
        Number.isFinite(seed.api) &&
        (apiSide.first === null || seed.api > apiSide.first)
      ) {
        apiSide.first = seed.api
      }
      scheduleFlush()
      return
    }
    const day = { api: emptyOfficialSide(), account: emptyOfficialSide() }
    if (carry && carry.date !== key) {
      for (const channel of ['api', 'account']) {
        if (typeof carry[channel] === 'number') {
          day[channel].first = carry[channel]
          day[channel].last = carry[channel]
        }
      }
    } else if (seed && typeof seed.api === 'number') {
      day.api.first = seed.api
      day.api.last = seed.api
    }
    official[key] = day
    scheduleFlush()
  }

  function sumLocal(predicate) {
    const result = { api: emptyBucket(), account: emptyBucket(), other: emptyBucket(), total: emptyBucket() }
    for (const [key, day] of Object.entries(days)) {
      if (!predicate(key)) continue
      for (const bucket of ['api', 'account', 'other']) {
        const value = day[bucket]
        if (!value) continue
        addInto(result[bucket], value)
        addInto(result.total, value)
      }
    }
    return result
  }

  function sumOfficial(predicate) {
    const result = { api: { spend: 0, known: false }, account: { spend: 0, known: false }, total: { spend: 0, known: false } }
    for (const [key, day] of Object.entries(official)) {
      if (!predicate(key)) continue
      for (const channel of ['api', 'account']) {
        const spend = officialSpend(day[channel])
        if (spend === null) continue
        result[channel].spend += spend
        result[channel].known = true
        result.total.spend += spend
        result.total.known = true
      }
    }
    return result
  }

  function windows(now) {
    const today = dayKey(now)
    const weekStart = weekStartKey(now)
    const month = monthKey(now)
    return {
      today: (key) => key === today,
      week: (key) => key >= weekStart,
      month: (key) => key.startsWith(month),
      total: () => true,
    }
  }

  function periods(now = Date.now()) {
    const test = windows(now)
    const local = {}
    const officialTotals = {}
    for (const [name, predicate] of Object.entries(test)) {
      local[name] = sumLocal(predicate)
      officialTotals[name] = sumOfficial(predicate)
    }
    return { local, official: officialTotals }
  }

  function summary(sessionId, now = Date.now()) {
    const session = sessions.get(sessionId)
    const providers = session?.providers || {}
    const total = emptyBucket()
    for (const bucket of Object.values(providers)) addInto(total, bucket)
    const aggregates = periods(now)
    return {
      ok: true,
      sessionId,
      providers,
      models: session?.models || {},
      total,
      updatedAt: session?.updatedAt || 0,
      periods: aggregates.local,
      official: aggregates.official,
      prices: { source: prices.source, at: prices.at },
    }
  }

  return { record, summary, periods, flush, sessions, sampleBalances, setPrices, priceTable, bootstrap }
}

function walletTotal(side) {
  if (!side) return null
  const wallets = Array.isArray(side.wallets) ? side.wallets : []
  if (wallets.length === 0) return null
  const cny = wallets.find((wallet) => wallet.currency === 'CNY')
  return (cny || wallets[0]).total
}

/** API-key channel balance: DeepSeek platform `GET /user/balance`. */
async function readApiBalance(ctx) {
  try {
    const credentials = ctx.get?.('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') return null
    const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
    if (!resolved?.value) return null
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${resolved.value}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return null
    const payload = await response.json()
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
    if (infos.length === 0) return null
    return {
      available: payload?.is_available !== false,
      wallets: infos.map((info) => ({
        currency: info.currency || 'CNY',
        total: Number(info.total_balance) || 0,
        granted: Number(info.granted_balance) || 0,
        toppedUp: Number(info.topped_up_balance) || 0,
      })),
    }
  } catch {
    return null
  }
}

/** Signed-in account balance: recharge + bonus wallets from the account platform. */
async function readAccountBalance(ctx) {
  try {
    const account = ctx.get?.('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') return null
    const result = await account.getBalance({
      version: '0.0.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (!result || result.status !== 'ready') return null
    return {
      wallets: (result.value || []).map((wallet) => ({
        currency: wallet.currency,
        total: Number(wallet.balance) || 0,
      })),
      bonus: (result.bonusWallets || []).map((wallet) => ({
        currency: wallet.currency,
        total: Number(wallet.balance) || 0,
      })),
    }
  } catch {
    return null
  }
}

/**
 * Best-effort read of the official CNY price table.
 * Returns null when the page is unreachable or the numbers cannot be recognized —
 * the caller then keeps the built-in table.
 */
export function parseOfficialPricing(html) {
  try {
    const text = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')

    // Each price row reads: <label> 空闲时段 <flash>元 <pro>元 高峰时段 <flash>元 <pro>元
    const row = (pattern) => {
      const match = pattern.exec(text)
      if (!match) return null
      const segment = text.slice(match.index, match.index + 140)
      const values = [...segment.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*元/g)].map((item) => Number(item[1]))
      return values.length >= 4 ? values : null
    }

    const cacheRead = row(/百万\s*tokens?\s*输入\s*（\s*缓存命中\s*）/)
    const input = row(/百万\s*tokens?\s*输入\s*（\s*缓存未命中\s*）/)
    const output = row(/百万\s*tokens?\s*输出/)
    if (!cacheRead && !input && !output) return null

    const table = {
      flash: { ...BUILTIN_PRICES.flash },
      pro: { ...BUILTIN_PRICES.pro },
    }
    // values = [flash 空闲, pro 空闲, flash 高峰, pro 高峰]; peak == off-peak × 2 is
    // re-applied by priceAt(), so only the off-peak column is stored.
    if (cacheRead) {
      table.flash.cacheRead = cacheRead[0]
      table.pro.cacheRead = cacheRead[1]
    }
    if (input) {
      table.flash.input = input[0]
      table.pro.input = input[1]
    }
    if (output) {
      table.flash.output = output[0]
      table.pro.output = output[1]
    }
    if (!cacheRead && !input && !output) return null
    return table
  } catch {
    return null
  }
}

export function apply(ctx) {
  const ledger = createLedger()
  ledger.bootstrap()

  ctx.effect(() => () => ledger.flush(), 'dsh-costline: ledger flush')

  let balanceCache = { at: 0, value: null }
  async function balances() {
    const now = Date.now()
    if (balanceCache.value && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value
    const [api, account] = await Promise.all([readApiBalance(ctx), readAccountBalance(ctx)])
    balanceCache = { at: now, value: { api, account } }
    // Each refresh is one official wallet sample: this is what turns balances into spend.
    ledger.sampleBalances(
      {
        api: walletTotal(api),
        account: walletTotal(account),
      },
      now,
    )
    return balanceCache.value
  }

  let priceFetchAt = 0
  let priceFetching = false
  async function refreshPrices() {
    if (priceFetching || Date.now() - priceFetchAt < PRICE_TTL_MS) return
    priceFetching = true
    priceFetchAt = Date.now()
    try {
      const response = await fetch(PRICING_PAGE, { signal: AbortSignal.timeout(10000) })
      if (response.ok) {
        const parsed = parseOfficialPricing(await response.text())
        if (parsed) ledger.setPrices(parsed, 'official')
      }
    } catch {
      /* keep the last known table */
    } finally {
      priceFetching = false
    }
  }

  // Backfill the local buckets from the session logs once per process, shortly after
  // boot so the first paint is not blocked by decompressing megabytes of history.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const result = backfillFromSessions(ledger)
        if (result.steps > 0) {
          ledger.flush()
          ctx.logger?.info?.(`[dsh-costline] backfilled ${result.steps} steps from ${result.sessions} session logs`)
        }
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-costline] backfill failed: ${error?.message ?? error}`)
      }
    }, 1500)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'dsh-costline: session backfill')

  // Keep sampling wallets even when no browser page is open: each sample advances the
  // official spend ledger, so a closed page never leaves a hole in today's total.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void balances()
    }, BALANCE_TTL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-costline: balance sampler')

  // Post-commit append feed: every settled assistant step carries exact usage.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return
      const usage = event.data?.usage
      if (!usage) return
      const source = event.data?.message?.source || {}
      ledger.record(String(session.id), {
        provider: source.provider || 'unknown',
        model: source.model || '',
        usage,
        atMs: event.time ?? Date.now(),
        seq: event.seq,
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-costline] failed to fold usage: ${error?.message ?? error}`)
    }
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-costline/summary',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') || ''
          if (url.searchParams.get('refresh') === '1') balanceCache = { at: 0, value: null }
          const balance = await balances()
          void refreshPrices()
          const body = JSON.stringify({ ...ledger.summary(sessionId), balance })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }),
    'dsh-costline: summary route',
  )
}
