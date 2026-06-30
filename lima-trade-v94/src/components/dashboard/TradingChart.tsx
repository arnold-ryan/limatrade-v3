'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  CrosshairMode,
} from 'lightweight-charts'

const MARKETS = [
  { id: 'R_10',   label: 'Vol 10'  },
  { id: 'R_25',   label: 'Vol 25'  },
  { id: 'R_50',   label: 'Vol 50'  },
  { id: 'R_75',   label: 'Vol 75'  },
  { id: 'R_100',  label: 'Vol 100' },
  { id: 'RDBULL', label: 'Bull'    },
  { id: 'RDBEAR', label: 'Bear'    },
]

const TIMEFRAMES = [
  { label: '1m',  granularity: 60   },
  { label: '5m',  granularity: 300  },
  { label: '15m', granularity: 900  },
  { label: '1h',  granularity: 3600 },
]

// Deriv public app_id — safe to use for market data, no auth required
const PUBLIC_APP_ID = '1089'

interface DerivCandle {
  epoch: number
  open:  string
  high:  string
  low:   string
  close: string
}

interface DerivOHLC {
  epoch: number
  open:  string
  high:  string
  low:   string
  close: string
}

export default function TradingChart({
  onMarketChange,
}: {
  onMarketChange?: (market: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)
  const seriesRef    = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)

  const [market,    setMarket]    = useState('R_10')
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[0])
  const [price,     setPrice]     = useState<string | null>(null)
  const [priceUp,   setPriceUp]   = useState(true)
  const [dayChange, setDayChange] = useState<{ pct: number; up: boolean } | null>(null)
  const [loading,   setLoading]   = useState(true)

  // ── Create chart once on mount ────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#000' },
        textColor:  '#E5E5E5',
      },
      grid: {
        vertLines: { color: 'rgba(252,163,17,0.05)' },
        horzLines: { color: 'rgba(252,163,17,0.05)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(252,163,17,0.15)',
      },
      timeScale: {
        borderColor: 'rgba(252,163,17,0.15)',
        timeVisible: true,
        secondsVisible: false,
      },
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })

    const series = chart.addCandlestickSeries({
      upColor:        '#22c55e',
      downColor:      '#ef4444',
      borderUpColor:  '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor:    '#22c55e',
      wickDownColor:  '#ef4444',
    })

    chartRef.current  = chart
    seriesRef.current = series

    // Resize observer — keep chart filling container
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width:  containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [])

  // ── Subscribe to market on change ─────────────────────────────────────────
  const subscribe = useCallback(() => {
    // Close any existing connection
    wsRef.current?.close()
    setLoading(true)

    const ws = new WebSocket(
      `wss://ws.binaryws.com/websockets/v3?app_id=${PUBLIC_APP_ID}`
    )
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          ticks_history:     market,
          adjust_start_time: 1,
          count:             120,
          end:               'latest',
          style:             'candles',
          granularity:       timeframe.granularity,
          subscribe:         1,
        })
      )
    }

    ws.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string)

      if (msg.error) {
        console.error('Deriv WS error:', msg.error.message)
        return
      }

      // Initial batch of candles
      if (msg.msg_type === 'candles' && msg.candles?.length) {
        const data = (msg.candles as DerivCandle[]).map(c => ({
          time:  c.epoch as UTCTimestamp,
          open:  parseFloat(c.open),
          high:  parseFloat(c.high),
          low:   parseFloat(c.low),
          close: parseFloat(c.close),
        }))

        seriesRef.current?.setData(data)
        chartRef.current?.timeScale().fitContent()
        setLoading(false)

        // Set current price + day change from dataset
        const last  = data[data.length - 1]
        const first = data[0]
        if (last && first) {
          setPrice(last.close.toFixed(last.close < 10 ? 5 : 2))
          const pct = ((last.close - first.open) / first.open) * 100
          setDayChange({ pct: Math.abs(pct), up: pct >= 0 })
        }
      }

      // Live candle update
      if (msg.msg_type === 'ohlc') {
        const c = msg.ohlc as DerivOHLC
        const prev = price ? parseFloat(price) : 0
        const next = parseFloat(c.close)

        seriesRef.current?.update({
          time:  parseFloat(c.epoch.toString()) as UTCTimestamp,
          open:  parseFloat(c.open),
          high:  parseFloat(c.high),
          low:   parseFloat(c.low),
          close: next,
        })

        setPriceUp(next >= prev)
        setPrice(next.toFixed(next < 10 ? 5 : 2))
      }
    }

    ws.onerror = () => setLoading(false)

    return () => ws.close()
  }, [market, timeframe]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cleanup = subscribe()
    return cleanup
  }, [subscribe])

  const selectMarket = (m: string) => {
    setMarket(m)
    onMarketChange?.(m)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {/* ── Controls bar ─────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0.6rem 1rem',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          gap: '0.4rem',
          overflowX: 'auto',
          background: '#050505',
        }}
      >
        {/* Market tabs */}
        {MARKETS.map(m => (
          <button
            key={m.id}
            onClick={() => selectMarket(m.id)}
            style={{
              padding: '0.35rem 0.85rem',
              borderRadius: '9999px',
              fontSize: '0.78rem',
              fontWeight: 600,
              border: '1px solid',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
              flexShrink: 0,
              borderColor: market === m.id ? 'var(--gold)'   : 'var(--border)',
              background:  market === m.id ? 'rgba(252,163,17,0.12)' : 'transparent',
              color:       market === m.id ? 'var(--gold)'   : 'rgba(229,229,229,0.55)',
            }}
          >
            {m.label}
          </button>
        ))}

        {/* Separator */}
        <div style={{ width: '1px', height: '20px', background: 'var(--border)', flexShrink: 0, marginLeft: '0.25rem' }} />

        {/* Live price */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          {price && (
            <span
              style={{
                fontWeight: 800,
                fontSize: '1.05rem',
                color: priceUp ? 'var(--up)' : 'var(--down)',
                letterSpacing: '-0.02em',
                transition: 'color 0.3s',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {price}
            </span>
          )}
          {dayChange && (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: dayChange.up ? 'var(--up)' : 'var(--down)',
              }}
            >
              {dayChange.up ? '▲' : '▼'} {dayChange.pct.toFixed(2)}%
            </span>
          )}
        </div>

        {/* Timeframe selector pushed to right */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
          {TIMEFRAMES.map(tf => (
            <button
              key={tf.label}
              onClick={() => setTimeframe(tf)}
              style={{
                padding: '0.3rem 0.6rem',
                borderRadius: '6px',
                fontSize: '0.72rem',
                fontWeight: 600,
                border: '1px solid',
                cursor: 'pointer',
                transition: 'all 0.15s',
                borderColor: timeframe.granularity === tf.granularity ? 'var(--gold)'   : 'var(--border)',
                background:  timeframe.granularity === tf.granularity ? 'rgba(252,163,17,0.12)' : 'transparent',
                color:       timeframe.granularity === tf.granularity ? 'var(--gold)'   : 'rgba(229,229,229,0.45)',
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Chart container ──────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(4px)',
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  border: '3px solid var(--border)',
                  borderTopColor: 'var(--gold)',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                  margin: '0 auto 0.75rem',
                }}
              />
              <p style={{ fontSize: '0.8rem', color: 'rgba(229,229,229,0.5)' }}>
                Loading market data…
              </p>
            </div>
          </div>
        )}
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  )
}
