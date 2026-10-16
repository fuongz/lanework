import { ArrowRight01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  PERMISSION_COPY,
  type PermissionAnswer,
  type PermissionRequest,
} from "#/../shared/conversation";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/**
 * The CLI asked to use a tool and is waiting (D1): what it would do, its
 * input on demand, and the answer — Allow, Allow and switch the session's
 * mode when the CLI offers it, or Deny.
 */
export function PermissionCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (id: string, answer: PermissionAnswer) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const answer = (value: PermissionAnswer) => {
    setBusy(true);
    void onAnswer(request.id, value).finally(() => setBusy(false));
  };
  return (
    <section
      aria-label={`Permission for ${request.tool}`}
      className="border-tone-amber/40 bg-tone-amber/[0.06] flex flex-col gap-2.5 rounded-xl border p-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <HugeiconsIcon
          icon={Shield01Icon}
          className="text-tone-amber mt-0.5 size-4 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium">
            Claude wants to use {request.tool}
          </span>
          <span className="text-muted-foreground text-[13px] [overflow-wrap:anywhere]">
            {request.summary}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start text-xs transition-colors"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn(
            "size-3 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
        Input
      </button>
      {open && (
        <pre className="bg-foreground/[0.04] max-h-64 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          <code>{request.input || "{}"}</code>
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => answer({ behavior: "allow" })}
        >
          Allow
        </Button>
        {request.suggestMode && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              answer({
                behavior: "allow",
                mode: request.suggestMode ?? undefined,
              })
            }
          >
            Allow and switch to {PERMISSION_COPY[request.suggestMode].label}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => answer({ behavior: "deny" })}
        >
          Deny
        </Button>
      </div>
    </section>
  );
}
