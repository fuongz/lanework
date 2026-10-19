import {
  ArrowUpRight01Icon,
  PlugSocketIcon,
  Refresh01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListeningPort } from "#/../shared/terminal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";

/** How often the ports are read again while the window has focus (FE-68/D7). */
const POLL_MS = 3000;

/** What a confirmation is for: one port's process, or every one listed. */
type Confirm = { kind: "one"; port: ListeningPort } | { kind: "all" };

/** `:5173`, or `3 ports`. */
function triggerText(ports: ListeningPort[]): string {
  const distinct = new Set(ports.map((row) => row.port));
  return distinct.size === 1 ? `:${ports[0].port}` : `${distinct.size} ports`;
}

/** How long `port`'s process has run: `4m`, `2h 5m`, `3d 6h`. */
function uptime(port: ListeningPort, now: number): string | null {
  if (port.startedAt === null) return null;
  const minutes = Math.max(1, Math.floor((now - port.startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * The project's listening TCP ports, beside the agents' usage on the terminal
 * bar (FE-68): what a dev server an agent started is listening on, and Stop —
 * like PortKiller, but only this project's processes, each Stop confirmed.
 *
 * ⚠️ Read every `POLL_MS` only while the window has focus, and at once when
 * it gets it back: `lsof` is cheap, not free. Hidden when nothing listens.
 */
export function PortsStrip({ workspace }: { workspace: string }) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<Confirm | null>(null);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef(workspace);
  current.current = workspace;

  const load = useCallback(async () => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    const asked = workspace;
    setLoading(true);
    try {
      const found = await surface.ports(asked);
      if (current.current === asked) setPorts(found);
    } catch {
      // A project with no folder here, or `lsof` failing: nothing to show.
      if (current.current === asked) setPorts([]);
    } finally {
      if (current.current === asked) setLoading(false);
    }
  }, [workspace]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project starts empty
  useEffect(() => {
    setPorts([]);
    setNotice(null);
    setConfirming(null);
  }, [workspace]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    };
    const pause = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (document.hasFocus()) start();
    else void load();
    window.addEventListener("focus", start);
    window.addEventListener("blur", pause);
    return () => {
      pause();
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", pause);
    };
  }, [load]);

  const stop = async () => {
    const surface = window.desktop?.terminal;
    if (!surface || !confirming || stopping) return;
    const asked = workspace;
    const targets =
      confirming.kind === "one"
        ? [confirming.port]
        : [...new Map(ports.map((row) => [row.pid, row])).values()];
    setStopping(true);
    setNotice(null);
    const failed: string[] = [];
    // One at a time: a stop may take another row's process with it, and
    // that one's own stop then reports it gone.
    for (const target of targets) {
      try {
        await surface.stopPort(asked, target.pid, target.start);
      } catch (error) {
        if (targets.length === 1)
          failed.push(ipcMessage(error, `Could not stop :${target.port}.`));
      }
    }
    if (current.current !== asked) return;
    setStopping(false);
    setConfirming(null);
    if (failed.length) setNotice(failed.join(" "));
    void load();
  };

  if (!ports.length) return null;
  const now = Date.now();
  const target = confirming?.kind === "one" ? confirming.port : null;

  return (
    <div className="flex shrink-0 items-center">
      <Popover>
        <PopoverTrigger
          render={<button type="button" />}
          data-testid="ports-strip"
          aria-label={`Listening ports: ${ports.map((row) => row.port).join(", ")}`}
          title="Ports this project listens on"
          className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-expanded:bg-foreground/[0.04] aria-expanded:text-foreground flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap tabular-nums transition-colors"
        >
          <span
            className="bg-tone-emerald size-1.5 shrink-0 rounded-full"
            aria-hidden="true"
          />
          <HugeiconsIcon
            icon={PlugSocketIcon}
            className="size-3 shrink-0"
            strokeWidth={2}
          />
          <span>{triggerText(ports)}</span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className="w-96 gap-1.5 p-2"
          aria-label="Listening ports"
          data-testid="ports-details"
        >
          <div className="flex items-center gap-2 px-1 pt-0.5">
            <h2 className="flex-1 text-[13px] leading-4 font-medium">
              Listening ports
            </h2>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label="Refresh ports"
              title="Refresh ports"
              aria-busy={loading}
              onClick={() => void load()}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                className={cn(
                  "size-3",
                  loading && "animate-spin motion-reduce:animate-none",
                )}
                strokeWidth={2}
              />
            </Button>
          </div>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {ports.map((row) => (
              <li
                key={`${row.pid}:${row.port}`}
                data-testid="port-row"
                className="bg-muted/50 ring-foreground/[0.06] flex items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-inset"
              >
                <span className="w-12 shrink-0 font-mono text-[13px] font-medium tabular-nums">
                  :{row.port}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className="truncate text-[12px] leading-4"
                    title={row.command}
                  >
                    {row.command || row.name}
                  </span>
                  <span className="text-muted-foreground truncate text-[10px] leading-4 tabular-nums">
                    {[
                      row.name,
                      `pid ${row.pid}`,
                      uptime(row, now),
                      row.via === "terminal" ? "from a terminal" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label={`Open localhost:${row.port}`}
                  title={`Open http://localhost:${row.port}`}
                  // Main opens a localhost URL in the OS browser (FE-68).
                  onClick={() =>
                    window.open(`http://localhost:${row.port}`, "_blank")
                  }
                >
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Stop :${row.port}`}
                  title={`Stop :${row.port}`}
                  disabled={stopping}
                  onClick={() => setConfirming({ kind: "one", port: row })}
                >
                  <HugeiconsIcon
                    icon={StopIcon}
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </Button>
              </li>
            ))}
          </ul>
          {notice && (
            <p
              role="alert"
              className="text-tone-amber px-1 text-[11px] leading-4"
            >
              {notice}
            </p>
          )}
          {new Set(ports.map((row) => row.pid)).size > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive self-end"
              disabled={stopping}
              onClick={() => setConfirming({ kind: "all" })}
            >
              Stop all
            </Button>
          )}
        </PopoverContent>
      </Popover>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !stopping) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target
                ? `Stop the process on :${target.port}?`
                : `Stop all ${new Set(ports.map((row) => row.pid)).size} processes?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target
                ? `pid ${target.pid} and what launched it are stopped; a shell, agent or terminal above it keeps running.`
                : "Every process listening in this project is stopped, with what launched it; shells, agents and terminals keep running."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 text-xs">
            <code>
              {target
                ? target.command || target.name
                : ports
                    .map((row) => `:${row.port}  ${row.command || row.name}`)
                    .join("\n")}
            </code>
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>
              Keep it running
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={stopping}
              onClick={() => void stop()}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
