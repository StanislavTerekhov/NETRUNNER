// NETRUNNER's own traffic by source: bytes through the policy proxy's tunnel are counted for that source.
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { NetProxy } from '../electron/main/services/net-proxy'
import { traffic } from '../electron/main/services/traffic'

describe('traffic counter', () => {
  it('counts the bytes of a CONNECT tunnel for its source', async () => {
    // A local echo server stands in for an internet host (loopback passes the policy in every mode).
    const echo = net.createServer(s => s.pipe(s))
    await new Promise<void>(r => echo.listen(0, '127.0.0.1', r))
    const port = (echo.address() as net.AddressInfo).port
    const proxy = new NetProxy(() => 'strict-offline')
    const url = new URL(await proxy.start('traffic-test'))
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(Number(url.port), '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`))
        let phase = 0
        s.on('data', d => {
          if (phase === 0 && /200 Connection Established/.test(d.toString())) {
            phase = 1
            s.write('x'.repeat(1000))
          } else if (phase === 1) {
            s.end()
          }
        })
        s.on('close', () => resolve())
        s.on('error', reject)
      })
      await new Promise(r => setTimeout(r, 100))
      const row = traffic.list().find(r => r.source === 'traffic-test')
      expect(row?.connections).toBe(1)
      expect(row?.sent).toBeGreaterThanOrEqual(1000)
      expect(row?.received).toBeGreaterThan(0)
    } finally {
      await proxy.stop()
      echo.close()
    }
  })
})
