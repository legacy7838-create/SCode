export interface IntranetProbeTcpTarget {
  /** Target unique ID; if not passed, host:port will be used by default. */
  id?: string;
  kind?: "tcp";
  host: string;
  /** Default 22 (SSH) */
  port?: number;
  /** Single detection timeout, default 800ms */
  timeoutMs?: number;
}

export interface IntranetProbeServiceTarget {
  /** Target unique ID; if not passed, the default url will be used */
  id?: string;
  kind: "service";
  /** Intranet detection service URL, for example provided by the caller through .env */
  url: string;
  /** Expect the service to return a marker (optional) */
  expectedMarker?: string;
  /** Simple token (optional); will be placed in the x-zcode-intranet-token request header */
  token?: string;
  /** Single detection timeout, default 800ms */
  timeoutMs?: number;
}

export type IntranetProbeTarget = IntranetProbeTcpTarget | IntranetProbeServiceTarget;

export interface IntranetProbeRequest {
  targets: IntranetProbeTarget[];
  /** Maximum number of retries per target, default 2, range [1, 3] */
  attempts?: number;
  /**
   * How many targets are hit count as "internal network".
   * Default is 1 (any target is reachable).
   */
  requiredSuccessCount?: number;
}

export interface IntranetProbeTcpTargetResult {
  targetId: string;
  kind: "tcp";
  host: string;
  port: number;
  reachable: boolean;
  /** Actual number of attempts */
  attemptCount: number;
  /** The time taken is milliseconds when reachable, and null when unreachable. */
  latencyMs: number | null;
  /** Reason for last failure */
  error?: string;
}

export interface IntranetProbeServiceTargetResult {
  targetId: string;
  kind: "service";
  url: string;
  reachable: boolean;
  /** Actual number of attempts */
  attemptCount: number;
  /** The time taken is milliseconds when reachable, and null when unreachable. */
  latencyMs: number | null;
  /** The service returns the marker (if any) */
  marker?: string;
  /** Reason for last failure */
  error?: string;
}

export type IntranetProbeTargetResult =
  | IntranetProbeTcpTargetResult
  | IntranetProbeServiceTargetResult;

export interface IntranetProbeResult {
  /** Final intranet decision */
  isIntranet: boolean;
  /** Number of successfully detected targets */
  reachedTargetCount: number;
  /** Decision threshold */
  requiredSuccessCount: number;
  /** Total number of targets participating in detection */
  totalTargets: number;
  /** Timestamp (ms) */
  checkedAt: number;
  /** Current detection strategy */
  strategy: "tcp-connect" | "service-http" | "mixed";
  results: IntranetProbeTargetResult[];
}

export interface IntranetProbeServiceResponse {
  ok: boolean;
  marker?: string;
}
