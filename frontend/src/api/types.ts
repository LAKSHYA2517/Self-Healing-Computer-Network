// Mirrors the real Flask API (state.snapshot(), topology.to_dict(), list_scenarios()).
export type Flow = 'static' | 'healing'
export type Health = 'healthy' | 'degraded' | 'down'
export type EventKind = 'fault' | 'detect' | 'reroute' | 'failback' | 'restore' | 'info' | 'critical'

export interface PathResult { nodes: string[]; links: string[]; cost: number }
export interface LinkMetric { status: 'up' | 'down'; latency_ms: number | null; loss_pct: number; util_pct: number }
export interface LinkHealth { health: Health; reason: string | null; since: number }
export interface Progress { pending: 'down' | 'degraded' | 'recover' | null; count: number; needed: number }
export interface Impairment { loss_pct: number; util_pct: number | null; latency_mult: number }

export interface FlowRow {
  tick: number; flow: Flow; path: string[] | null; delivery_pct: number; delay_ms: number | null
  throughput_mbps: number; lost_packets: number; available: boolean
}
export interface Kpi {
  delivery_pct: number | null; delay_ms: number | null; throughput_mbps: number | null
  available: boolean | null; lost_packets: number; route_changes: number; availability_pct: number
  last_recovery_ticks?: number | null
}
export interface SimEvent { tick: number; level: string; kind: EventKind; message: string }
export interface RouteChange {
  tick: number; kind: 'reroute' | 'failback' | 'recovery'; from: string; to: string; cost: number; reason: string
}
export interface FaultEntry {
  tick: number; op: string; target: string; restored_tick: number | null; description: string
}
export interface ScenarioState {
  name: string | null; title: string | null; duration: number; running: boolean; finished: boolean
}
export interface SimConfig { hold_down_ticks: number; k_down: number; k_degraded: number; k_recover: number }

export interface Snapshot {
  tick: number
  paused: boolean
  tick_seconds: number
  config: SimConfig
  detector_progress: Record<string, Progress>
  fault_log: FaultEntry[]
  failed_links: string[]
  failed_nodes: string[]
  impairments: Record<string, Impairment>
  baseline_path: PathResult
  static_path: PathResult
  healing_path: PathResult | null
  route_status: 'OK' | 'BROKEN'
  link_metrics: Record<string, LinkMetric>
  link_health: Record<string, LinkHealth>
  dead_nodes: string[]
  history: Record<string, (number | null)[]>
  route_changes: RouteChange[]
  kpis: Record<Flow, Kpi>
  series: Record<Flow, FlowRow[]>
  events: SimEvent[]
  scenario: ScenarioState
}

export interface TopoNode { id: string; x: number; y: number }
export interface TopoLink { id: string; a: string; b: string; latency: number; bw: number }
export interface Topology { nodes: TopoNode[]; links: TopoLink[]; source: string; destination: string }

export interface PlannedEvent { t: number; op: string; id: string; loss_pct?: number; util_pct?: number }
export interface ScenarioInfo { name: string; title: string; duration: number; events: PlannedEvent[] }

export interface FaultSummary {
  fault: string; fault_tick: number; detected_tick: number | null; detection_ticks: number | null
  reroute_tick: number | null; recovery_ticks: number | null
}
export interface FlowSummary {
  sent: number; lost: number; loss_pct: number; outage_ticks: number; availability_pct: number
  route_changes: number; avg_delay_ms: number | null; avg_throughput_mbps: number
}
export interface Summary {
  ticks: number; static: FlowSummary; healing: FlowSummary & { faults: FaultSummary[] }
}

/** A saved run: what `scenario_runner.py --dump-snapshots` and "Save recording" write. */
export interface Recording {
  version: 1; topology: Topology; scenario: ScenarioInfo | null; snapshots: Snapshot[]; summary?: Summary
}

/** Anything the store can drive: the live Flask API or an offline recording. */
export interface Backend {
  readonly replay: boolean
  topology(): Promise<Topology>
  scenarios(): Promise<ScenarioInfo[]>
  state(): Promise<Snapshot>
  summary(): Promise<Summary>
  pause(): Promise<Snapshot>
  resume(): Promise<Snapshot>
  step(): Promise<Snapshot>
  speed(tickSeconds: number): Promise<Snapshot>
  startScenario(name: string): Promise<Snapshot>
  reset(): Promise<Snapshot>
  inject(action: 'fail' | 'restore', type: 'link' | 'node', id: string): Promise<Snapshot>
  degrade(id: string, lossPct: number): Promise<Snapshot>
  congest(id: string, utilPct: number): Promise<Snapshot>
  clear(id: string): Promise<Snapshot>
}
