/**
 * Bytes NETRUNNER itself moved over the network since it started, by source (agent, terminal, web tools, model and
 * runtime downloads). Windows has no per-process counters without administrator tracing, but every byte NETRUNNER
 * sends or receives passes one of these points, so the total is exact for NETRUNNER (the machine-wide figure stays in
 * SYSTEM MONITOR).
 */
export interface TrafficSource {
  source: string
  sent: number
  received: number
  connections: number
}

export class TrafficCounter {
  private readonly bySource = new Map<string, TrafficSource>()

  private get(source: string): TrafficSource {
    let s = this.bySource.get(source)
    if (!s) this.bySource.set(source, (s = { source, sent: 0, received: 0, connections: 0 }))
    return s
  }

  connection(source: string): void {
    this.get(source).connections++
  }

  add(source: string, sent: number, received: number): void {
    const s = this.get(source)
    s.sent += Math.max(0, sent)
    s.received += Math.max(0, received)
  }

  list(): TrafficSource[] {
    return [...this.bySource.values()].map(s => ({ ...s })).sort((a, b) => b.sent + b.received - (a.sent + a.received))
  }
}

/** One counter for the whole app. */
export const traffic = new TrafficCounter()
