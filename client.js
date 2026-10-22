// dsh-costline — browser half.
//
// One compact entry in the composer dock, beside the shipped tok/s / cache-hit row:
//
//   [今日 ▾] [合计 ▾] ¥1.23 · API 1.00 · 账户 0.23 · 余 100.00 / 10.00
//
// Sources:
//   API channel   — ALWAYS the local token estimate: the API key belongs to a shared
//                   account, so its wallet delta includes other people's usage. The
//                   estimate is rebuilt from the session logs, so it covers every day
//                   the logs still hold, not just "since install".
//   account       — official wallet delta when it covers at least the local estimate,
//                   otherwise the local estimate (partial official coverage).
//   total         — API + account.
;(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return

  window.__ModuleLoader__.load({
    id: 'dsh-costline',
    factory: (require) => {
      const React = require('react')
      const h = React.createElement
      const { useEffect, useState } = React

      const POLL_MS = 5000
      const PERIOD_KEY = 'dsh-costline:period'
      const CHANNEL_KEY = 'dsh-costline:channel'
      const PERIODS = [
        { key: 'today', label: '今日' },
        { key: 'week', label: '本周' },
        { key: 'month', label: '本月' },
        { key: 'total', label: '累计' },
      ]
      const CHANNELS = [
        { key: 'total', label: '合计' },
        { key: 'api', label: 'API' },
        { key: 'account', label: '账户' },
      ]

      function readStored(key, fallback, options) {
        try {
          const saved = window.localStorage.getItem(key)
          if (saved && options.some((option) => option.key === saved)) return saved
        } catch {
          /* private mode */
        }
        return fallback
      }

      function money(value, withSymbol = false) {
        const n = Number(value)
        if (!Number.isFinite(n)) return withSymbol ? '¥—' : '—'
        const body = n === 0 ? '0' : n < 0.0001 ? n.toExponential(1) : n.toFixed(n < 1 ? 4 : 2)
        return withSymbol ? '¥' + body : body
      }

      function tokens(value) {
        const n = Number(value) || 0
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
        return String(n)
      }

      function walletTotal(side) {
        if (!side) return null
        const wallets = Array.isArray(side.wallets) ? side.wallets : []
        if (wallets.length === 0) return null
        const cny = wallets.find((wallet) => wallet.currency === 'CNY')
        return (cny || wallets[0]).total
      }

      /** Split one window into api / account / total, with the source of each side. */
      function resolveWindow(data, period) {
        const local = data?.periods?.[period] || {}
        const official = data?.official?.[period] || {}
        const api = Number(local.api?.cost) || 0
        const accountLocal = Number(local.account?.cost) || 0
        const accountOfficial = official.account?.known ? Number(official.account.spend) : null
        const account = accountOfficial === null ? accountLocal : Math.max(accountOfficial, accountLocal)
        const accountSource = accountOfficial !== null && accountOfficial >= accountLocal ? '官方' : '估算'
        return { api, account, total: api + account, accountSource, apiSource: '估算' }
      }

      function useSummary(sessionId) {
        const [data, setData] = useState(null)
        useEffect(() => {
          if (!sessionId) return undefined
          let alive = true
          let timer
          const pull = async () => {
            try {
              const response = await fetch('/dsh-costline/summary?sessionId=' + encodeURIComponent(sessionId), {
                credentials: 'same-origin',
                cache: 'no-store',
              })
              if (!response.ok) return
              const json = await response.json()
              if (alive) setData(json)
            } catch {
              /* route not ready yet / offline: keep the last value */
            }
          }
          pull()
          timer = setInterval(pull, POLL_MS)
          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [sessionId])
        return data
      }

      const selectStyle = {
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 1px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.95,
        cursor: 'pointer',
        outline: 'none',
        fontVariantNumeric: 'tabular-nums',
      }

      function Picker(props) {
        return h(
          'select',
          { value: props.value, onChange: props.onChange, title: props.title, style: selectStyle },
          props.options.map((option) => h('option', { key: option.key, value: option.key }, option.label)),
        )
      }

      function BillingRow(props) {
        const data = useSummary(props.sessionId)
        const [period, setPeriod] = useState(() => readStored(PERIOD_KEY, 'today', PERIODS))
        const [channel, setChannel] = useState(() => readStored(CHANNEL_KEY, 'total', CHANNELS))

        const apiBalance = walletTotal(data?.balance?.api)
        const accountBalance = walletTotal(data?.balance?.account)
        const window = resolveWindow(data, period)

        const persist = (key, value) => {
          try {
            window.localStorage.setItem(key, value)
          } catch {
            /* private mode */
          }
        }

        let balanceText
        if (channel === 'api') balanceText = apiBalance === null ? '—' : money(apiBalance)
        else if (channel === 'account') balanceText = accountBalance === null ? '—' : money(accountBalance)
        else {
          const bits = []
          if (apiBalance !== null) bits.push(money(apiBalance))
          if (accountBalance !== null) bits.push(money(accountBalance))
          balanceText = bits.length ? bits.join(' / ') : '—'
        }

        const style = {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          lineHeight: '16px',
          opacity: 0.75,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }
        const dot = (key) => h('span', { key, style: { opacity: 0.35 } }, '·')

        const parts = [
          h(Picker, {
            key: 'period',
            value: period,
            title: '切换统计窗口',
            options: PERIODS,
            onChange: (event) => {
              setPeriod(event.target.value)
              persist(PERIOD_KEY, event.target.value)
            },
          }),
          h(Picker, {
            key: 'channel',
            value: channel,
            title: '切换通道：合计 / API key / 登录账户',
            options: CHANNELS,
            onChange: (event) => {
              setChannel(event.target.value)
              persist(CHANNEL_KEY, event.target.value)
            },
          }),
        ]

        if (channel === 'total') {
          parts.push(
            h('span', { key: 'value', style: { opacity: 1 } }, money(window.total, true)),
            dot('d1'),
            h('span', { key: 'api', title: 'API key 通道（本机 token × 官网价）' }, 'API ' + money(window.api)),
            dot('d2'),
            h('span', { key: 'account', title: '登录账户通道（余额变化，取不到时用本机估算）' }, '账户 ' + money(window.account)),
          )
        } else if (channel === 'api') {
          parts.push(h('span', { key: 'value', style: { opacity: 1 } }, money(window.api, true)))
        } else {
          parts.push(h('span', { key: 'value', style: { opacity: 1 } }, money(window.account, true)))
        }

        parts.push(dot('d3'), h('span', { key: 'balanceLabel' }, '余'), h('span', { key: 'balance' }, balanceText))

        const windowLine = PERIODS.map((item) => {
          const w = resolveWindow(data, item.key)
          return item.label + ' 合计 ' + money(w.total) + '（API ' + money(w.api) + ' / 账户 ' + money(w.account) + '）'
        }).join('\n')

        const title = [
          windowLine,
          '',
          'API：本机 token × 官网单价（共享账户，余额差不可用），已由会话日志回溯',
          '账户：官方钱包变化优先，覆盖不足时回落本机估算（当前来源 ' + window.accountSource + '）',
          '计价来源：' + (data?.prices?.source === 'official' ? '官网定价页' : '内置价表'),
          '当前窗口 token：' + tokens(data?.periods?.[period]?.total?.input) + ' in / ' + tokens(data?.periods?.[period]?.total?.output) + ' out',
          '本会话：' + money(data?.total?.cost) + ' · ' + (data?.total?.calls || 0) + ' 步',
          apiBalance !== null ? 'API 余额（共享账户）：' + money(apiBalance) : 'API 余额：未配置 key 或查询失败',
          accountBalance !== null ? '账户余额：' + money(accountBalance) : '账户余额：未登录或查询失败',
        ].join('\n')

        return h('div', { title, style }, parts)
      }

      function apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', function* () {
          yield ctx.slots.register({ name: 'conversation.composer.dock', id: 'costline', order: 5 }, BillingRow)
        })
      }

      return { name: 'dsh-costline', inject: ['slots'], apply }
    },
  })
})()
