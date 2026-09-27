// Shape of `networkQuality -c [-M 4 -u]` JSON output — only the fields this
// command reads. `ul_throughput`/`responsiveness`/`ul_bytes_transferred` are
// present only on a full test (`-c` alone); the quick download-only test
// (`-c -M 4 -u`) omits them entirely.
export interface NetworkQualityResult {
  dl_throughput: number; // bits/s
  ul_throughput?: number; // bits/s
  base_rtt: number; // ms
  responsiveness?: number; // RPM
  dl_bytes_transferred: number;
  ul_bytes_transferred?: number;
  interface_name: string;
  test_endpoint: string;
  start_date: string;
  end_date: string;
}

// A trimmed, unit-converted record — what actually gets persisted to
// LocalStorage history.
export interface SpeedTestRecord {
  timestamp: number; // epoch ms, when the test ran
  full: boolean;
  dlMbps: number;
  ulMbps: number | null;
  latencyMs: number;
  responsiveness: number | null;
  dataUsedMB: number;
  interfaceName: string;
}
