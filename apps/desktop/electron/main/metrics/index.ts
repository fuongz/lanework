// The resource log (FE-115). While switched on in Settings → About, main
// samples every 30 s how much CPU and memory each of Lanework's processes
// used and what the app was doing then, and keeps 24 hours of it under
// <appHome>/metrics. Nothing leaves the machine.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { app, BrowserWindow, type ProcessMetric, shell } from "electron";
import {
  type MetricsProcess,
  type MetricsSample,
  type MetricsSettings,
  metricsChannels,
} from "../../../shared/metrics";
import { handle } from "../ipc";
import { windowLocation } from "../notifications";
import { metricsDir } from "../paths";
import { terminalActivity } from "../terminal";
import { appendSample, hourFile, pruneSamples, routeTemplate } from "./log";

const INTERVAL_MS = 30_000;

const settingsFile = () => join(app.getPath("userData"), "metrics.json");

let cache: MetricsSettings | null = null;

async function readSettings(): Promise<MetricsSettings> {
  if (cache) return cache;
  try {
    const saved = JSON.parse(await readFile(settingsFile(), "utf8"));
    cache = { enabled: saved?.enabled === true };
  } catch {
    cache = { enabled: false };
  }
  return cache;
}

async function persist(value: MetricsSettings): Promise<void> {
  const file = settingsFile();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

function kindOf(type: ProcessMetric["type"]): MetricsProcess {
  switch (type) {
    case "Browser":
      return "main";
    case "Tab":
      return "renderer";
    case "GPU":
      return "gpu";
    case "Utility":
      return "utility";
    default:
      return "other";
  }
}

function windowState(): MetricsSample["window"] {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return "none";
  if (window.isMinimized()) return "minimized";
  if (!window.isVisible()) return "hidden";
  return window.isFocused() ? "focused" : "blurred";
}

const zero = (): Record<MetricsProcess, number> => ({
  main: 0,
  renderer: 0,
  gpu: 0,
  utility: 0,
  other: 0,
});

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Each process's CPU seconds at the last sample, by pid, and when that was.
 * The next sample's % is the difference over the wall time between them, so
 * no other caller of `getAppMetrics` can skew it.
 */
let previous = new Map<number, number>();
let previousAt = 0;
let timer: NodeJS.Timeout | null = null;
let lastHour: string | null = null;

/** Read every process's CPU seconds now; % only once there is a baseline. */
function readProcesses(cores: number): {
  cpu: Record<MetricsProcess, number>;
  mem: Record<MetricsProcess, number>;
  procs: number;
} {
  const now = Date.now();
  const elapsed = previousAt ? (now - previousAt) / 1000 : 0;
  const metrics = app.getAppMetrics();
  const cpu = zero();
  const mem = zero();
  const next = new Map<number, number>();
  for (const metric of metrics) {
    const kind = kindOf(metric.type);
    mem[kind] += metric.memory.workingSetSize / 1024;
    const seconds = metric.cpu.cumulativeCPUUsage;
    if (seconds === undefined) {
      // Electron's own %, which it divides by the cores.
      cpu[kind] += metric.cpu.percentCPUUsage * cores;
      continue;
    }
    next.set(metric.pid, seconds);
    const before = previous.get(metric.pid);
    if (elapsed > 0 && before !== undefined)
      cpu[kind] += ((seconds - before) / elapsed) * 100;
  }
  previous = next;
  previousAt = now;
  for (const kind of Object.keys(cpu) as MetricsProcess[]) {
    cpu[kind] = round(Math.max(0, cpu[kind]));
    mem[kind] = round(mem[kind]);
  }
  return { cpu, mem, procs: metrics.length };
}

async function sample(): Promise<void> {
  const cores = cpus().length || 1;
  const { cpu, mem, procs } = readProcesses(cores);
  const activity = await terminalActivity();
  const at = new Date();
  const line: MetricsSample = {
    t: at.toISOString(),
    v: app.getVersion(),
    up: Math.round(process.uptime()),
    cores,
    cpu,
    mem,
    procs,
    window: windowState(),
    route: routeTemplate(windowLocation()),
    ...activity,
  };
  const dir = metricsDir();
  await appendSample(dir, line);
  // Once an hour, when a new file starts, the oldest goes.
  const hour = hourFile(at);
  if (hour !== lastHour) {
    lastHour = hour;
    await pruneSamples(dir, at);
  }
}

function start(): void {
  if (timer) return;
  // The baseline: the first line written is 30 s of real use, not the time
  // since each process started.
  previous = new Map();
  previousAt = 0;
  lastHour = null;
  readProcesses(cpus().length || 1);
  timer = setInterval(() => {
    void sample().catch(() => {
      // A sample that cannot be written is dropped; the next one tries again.
    });
  }, INTERVAL_MS);
  timer.unref();
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function registerMetrics(devUrl?: string): void {
  void readSettings().then((settings) => {
    if (settings.enabled) start();
  });
  app.on("will-quit", stop);

  handle(metricsChannels.get, devUrl, (args): Promise<MetricsSettings> => {
    if (args.length) throw new Error("This operation takes no arguments");
    return readSettings();
  });

  handle(
    metricsChannels.set,
    devUrl,
    async (args): Promise<MetricsSettings> => {
      const [enabled] = args;
      if (args.length !== 1 || typeof enabled !== "boolean")
        throw new Error("On or off is required.");
      const next = { enabled };
      cache = next;
      await persist(next).catch(() => {
        // Not saved: this run still follows the switch.
      });
      if (enabled) start();
      else stop();
      return next;
    },
  );

  handle(metricsChannels.reveal, devUrl, async (args): Promise<void> => {
    if (args.length) throw new Error("This operation takes no arguments");
    const dir = metricsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await shell.openPath(dir);
  });
}
