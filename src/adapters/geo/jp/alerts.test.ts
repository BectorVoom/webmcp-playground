import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { JpAlertsProvider, JMA_WARNING_URL } from './alerts'
import tokyoPayload from '../../../../fixtures/geo/jp/alerts/upstream/jma-r8-130000-tokyo.json'
import fukuiPayload from '../../../../fixtures/geo/jp/alerts/upstream/jma-r8-180000-fukui.json'

const FUKUI = { latitude: 36.0619, longitude: 136.2233 }
const TOKYO = { latitude: 35.6812, longitude: 139.7671 }

const stubProxy = (body: unknown, status = 200) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const ask = (body: unknown, at = FUKUI, extra: Record<string, unknown> = {}) => {
  const { fetchImpl } = stubProxy(body)
  return Effect.runPromise(
    new JpAlertsProvider(fetchImpl).alertsFor({ at, radiusKm: 20, ...extra }),
  )
}

describe('JpAlertsProvider (live JMA)', () => {
  it('reads the current r8 feed, not the frozen legacy path', () => {
    // The old `data/warning/{code}.json` still answers 200 with well-formed JSON, but stopped
    // being republished in May 2026. Reading it reported "nothing in force" for Fukui on a day it
    // was under a level 5 大雨特別警報.
    expect(JMA_WARNING_URL('180000')).toBe(
      'https://www.jma.go.jp/bosai/warning/data/r8/180000.json',
    )
    expect(JMA_WARNING_URL('180000')).not.toContain('/data/warning/')
  })

  it('asks JMA for the warning office covering the query', async () => {
    const { calls, fetchImpl } = stubProxy(fukuiPayload)
    await Effect.runPromise(new JpAlertsProvider(fetchImpl).alertsFor({ at: FUKUI, radiusKm: 20 }))

    expect(calls[0]?.url).toBe('/api/geo/alerts')
    expect(calls[0]?.body.upstreamUrl).toBe(JMA_WARNING_URL('180000'))
  })

  it('routes Hokkaido and Okinawa to their own offices rather than a prefecture code', async () => {
    const sapporo = stubProxy(fukuiPayload)
    await Effect.runPromise(
      new JpAlertsProvider(sapporo.fetchImpl).alertsFor({
        at: { latitude: 43.0618, longitude: 141.3545 },
        radiusKm: 20,
      }),
    )
    expect(sapporo.calls[0]?.body.upstreamUrl).toBe(JMA_WARNING_URL('016000'))

    const ishigaki = stubProxy(fukuiPayload)
    await Effect.runPromise(
      new JpAlertsProvider(ishigaki.fetchImpl).alertsFor({
        at: { latitude: 24.3448, longitude: 124.1572 },
        radiusKm: 20,
      }),
    )
    expect(ishigaki.calls[0]?.body.upstreamUrl).toBe(JMA_WARNING_URL('474000'))
  })

  it('reports the level 5 大雨特別警報 in force over Fukui', async () => {
    const res = await ask(fukuiPayload)

    const special = res.alerts.find((a) => a.event === '大雨特別警報')
    expect(special).toBeDefined()
    expect(special?.severity).toBe('extreme')
    expect(special?.areaDescription).toBe('福井県（嶺北）')
    // JMA's own words, verbatim — the whole point of not summarising.
    expect(special?.description).toContain('レベル５大雨特別警報')
  })

  it('ranks the special warning first, so a result cap cannot drop it', async () => {
    const res = await ask(fukuiPayload, FUKUI, { limit: 1 })

    expect(res.alerts).toHaveLength(1)
    expect(res.alerts[0]?.event).toBe('大雨特別警報')
    expect(res.coverage.reason).toBe('result_cap')
  })

  it('reads warnings out of every bulletin in the file, not just the first', async () => {
    const res = await ask(fukuiPayload)

    // 大雨特別警報 comes from VPWW55, 土砂災害警戒情報 from VPWW56, 雷注意報 from VPWW61.
    expect(res.alerts.map((a) => a.event)).toEqual(
      expect.arrayContaining(['大雨特別警報', '土砂災害警戒情報', '雷注意報']),
    )
  })

  it("attaches each alert to its own bulletin's prose", async () => {
    const res = await ask(fukuiPayload)

    expect(res.alerts.find((a) => a.event === '土砂災害警戒情報')?.description).toBe(
      '嶺北では、土砂災害に厳重に警戒してください。',
    )
    expect(res.alerts.find((a) => a.event === '雷注意報')?.description).toContain('竜巻')
  })

  it('drops lifted warnings', async () => {
    const res = await ask(fukuiPayload)

    // 強風注意報 (15) and 波浪注意報 (16) are both present at status 解除.
    expect(res.alerts.map((a) => a.event)).not.toContain('強風注意報')
    expect(res.alerts.map((a) => a.event)).not.toContain('波浪注意報')
  })

  it('carries JMA provenance and marks the data live', async () => {
    const res = await ask(fukuiPayload)

    const provenance = res.alerts[0]!.provenance
    expect(provenance.mode).toBe('live')
    expect(provenance.sourceId).toBe('jp.jma.warnings')
    expect(provenance.upstreamUrl).toBe(JMA_WARNING_URL('180000'))
    expect(res.alerts[0]!.language).toBe('ja')
    // R4.6 / ADR-5: verbatim only, so no invented English translation.
    expect(res.alerts[0]!.officialTranslation).toBeUndefined()
  })

  it('names the areas a warning covers', async () => {
    const res = await ask(tokyoPayload, TOKYO)

    expect(res.alerts.find((a) => a.event === '濃霧注意報')?.areaDescription).toBe(
      '東京都（東京地方）',
    )
    expect(res.alerts.find((a) => a.event === '雷注意報')?.areaDescription).toBe(
      '東京都（伊豆諸島南部）',
    )
  })

  it('passes through a warning code it has no name for, rather than hiding it', async () => {
    const payload = [
      {
        reportDatetime: new Date().toISOString(),
        headlineText: '特殊な警報が発表されています。',
        dataTypeCode: 'VPWW99',
        warning: { class10Items: [{ areaCode: '180010', kinds: [{ code: '99', status: '発表' }] }] },
      },
    ]
    const res = await ask(payload)

    expect(res.alerts).toHaveLength(1)
    expect(res.alerts[0]?.event).toBe('気象警報・注意報（コード99）')
    expect(res.alerts[0]?.severity).toBe('unknown')
    expect(res.alerts[0]?.description).toBe('特殊な警報が発表されています。')
  })

  it('ranks an unnamed warning above known advisories, not below them', async () => {
    const payload = [
      {
        reportDatetime: new Date().toISOString(),
        headlineText: 'test',
        warning: {
          class10Items: [
            {
              areaCode: '180010',
              kinds: [
                { code: '21', status: '発表' }, // 乾燥注意報 — moderate
                { code: '99', status: '発表' }, // unknown
              ],
            },
          ],
        },
      },
    ]
    const res = await ask(payload, FUKUI, { limit: 1 })

    // An unrecognised official warning is not evidence of a mild one.
    expect(res.alerts[0]?.event).toBe('気象警報・注意報（コード99）')
  })

  it('flags a feed that has stopped being republished instead of reading it as all-clear', async () => {
    const payload = [
      {
        // Exactly the failure that hid Fukui's special warning: a well-formed but frozen feed.
        reportDatetime: '2026-05-26T19:48:00+09:00',
        headlineText: '注意報を解除します。',
        warning: { class10Items: [{ areaCode: '180020', kinds: [{ code: '21', status: '解除' }] }] },
      },
    ]
    const res = await ask(payload)

    expect(res.alerts).toEqual([])
    expect(res.staleness.stale).toBe(true)
    expect(res.coverage.state).toBe('partial')
    expect(res.coverage.detail).toContain('possibly dead endpoint')
  })

  it('does not flag a current feed that simply has nothing in force', async () => {
    const payload = [
      {
        reportDatetime: new Date().toISOString(),
        headlineText: '注意報を解除します。',
        warning: { class10Items: [{ areaCode: '180020', kinds: [{ code: '21', status: '解除' }] }] },
      },
    ]
    const res = await ask(payload)

    expect(res.alerts).toEqual([])
    expect(res.staleness.stale).toBe(false)
    expect(res.coverage.state).toBe('full')
  })

  it('reports a source failure instead of falling back to the Tokyo fixture', async () => {
    const { fetchImpl } = stubProxy('upstream exploded', 502)
    const exit = await Effect.runPromiseExit(
      new JpAlertsProvider(fetchImpl).alertsFor({ at: FUKUI, radiusKm: 20 }),
    )

    expect(exit._tag).toBe('Failure')
  })

  it('uses the recorded feed only when the server itself is in fixture mode', async () => {
    const res = await ask({ ok: true, mode: 'fixture', sourceId: 'jp.jma.warnings', data: null })

    expect(res.alerts).toEqual([])
    expect(res.coverage.reason).toBe('no_data_for_area')
  })
})
