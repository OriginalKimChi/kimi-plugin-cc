export type DriftKind = "missing_trailing_marker" | "stream_json_malformed";

export const DRIFT_THRESHOLD = 3;
const RECENT_KINDS_CAP = 10;

export interface DriftState {
  count: number;
  active: boolean;
  recentKinds: DriftKind[];
}

let _count = 0;
let _recent: DriftKind[] = [];

export function recordDriftEvent(kind: DriftKind): void {
  _count += 1;
  _recent.push(kind);
  if (_recent.length > RECENT_KINDS_CAP) {
    _recent = _recent.slice(-RECENT_KINDS_CAP);
  }
}

export function getDriftState(): DriftState {
  return {
    count: _count,
    active: _count >= DRIFT_THRESHOLD,
    recentKinds: [..._recent],
  };
}

/** Test-only / process-restart helper. Resets to the initial state. */
export function resetDriftState(): void {
  _count = 0;
  _recent = [];
}
