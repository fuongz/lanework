// The resource log (FE-115): every 30 s, main notes how much CPU and memory
// each of Lanework's processes used, and what the app was doing then. It is
// kept 24 hours under <appHome>/metrics, on this machine only, and is off
// until the person switches it on in Settings → About.

/** One line of an hour's file: numbers and counts, never a name or a path. */
export interface MetricsSample {
  /** When, ISO 8601 UTC. */
  t: string;
  /** The app's version. */
  v: string;
  /** Seconds since the app started. */
  up: number;
  /** Logical CPU cores: 100 is one core busy, as `ps` counts. */
  cores: number;
  /** CPU % of one core over the last interval, by process type. */
  cpu: Record<MetricsProcess, number>;
  /** Working set in MB, by process type. */
  mem: Record<MetricsProcess, number>;
  /** How many processes Lanework runs. */
  procs: number;
  /** The window: in front, behind another, hidden, minimized, or none. */
  window: "focused" | "blurred" | "hidden" | "minimized" | "none";
  /** The screen, with every name and id replaced by `$`. */
  route: string | null;
  /** Live terminal tabs. */
  terminals: number;
  /** Conversations a turn runs in now. */
  working: number;
  /** Conversations with a background task running. */
  background: number;
  /** Whether a Pull is reading the CLIs' transcripts. */
  pulling: boolean;
  /** Projects whose transcripts are being watched. */
  watched: number;
}

/** `main` is Electron's browser process; `utility` covers the pty host and the network service. */
export type MetricsProcess = "main" | "renderer" | "gpu" | "utility" | "other";

export interface MetricsSettings {
  /** Off until switched on (FE-115/D5). */
  enabled: boolean;
}

export const metricsChannels = {
  get: "metrics:get",
  set: "metrics:set",
  /** Open the folder in Finder. */
  reveal: "metrics:reveal",
} as const;

export interface DesktopMetricsApi {
  get: () => Promise<MetricsSettings>;
  set: (enabled: boolean) => Promise<MetricsSettings>;
  reveal: () => Promise<void>;
}
