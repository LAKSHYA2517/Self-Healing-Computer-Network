/** Plain-language definitions shown by <Tip>. Keys are lowercase. */
export const GLOSSARY: Record<string, string> = {
  delivery: 'The share of packets that arrive at the destination. 100% means nothing was lost.',
  delay: 'How long a packet takes to travel from R1 to R10, adding up every link on the way (milliseconds).',
  throughput: 'How much data per second actually gets through, limited by the busiest link on the path (Mbps).',
  availability: 'The share of time the flow delivered at least 90% of its packets.',
  detection: 'The system cannot see a failure directly. It decides a link is down only after several failed checks in a row.',
  degraded: 'The link still works, but loses many packets or is slow or overloaded.',
  failback: 'Moving traffic back to the preferred shortest path once it is trusted again.',
  'hold-down': 'A short waiting time after a route change so the route does not flip back and forth.',
  hysteresis: 'Needing more evidence to trust a link again than to distrust it, which stops flapping.',
  dijkstra: 'The classic shortest-path algorithm. It finds the cheapest route using only links that still work.',
  reroute: 'Switching the self-healing flow to a different path that avoids the fault.',
  static: 'Static routing picks a route once and never changes it, even if that route breaks.',
}
