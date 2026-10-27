import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ListSkeleton,
  TextSkeleton,
} from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { ipcMessage } from "#/lib/ipc-error";
import {
  allModels,
  EFFORT_LABELS,
  EFFORTS,
  type Effort,
} from "../../../../shared/conversation";
import {
  JEV_PROVIDERS,
  type JevConfig,
  type JevProvider,
  type JevState,
  JUDGE_POINTS,
  type JudgeLogEntry,
  type JudgeMode,
  type JudgePoint,
  type JudgeResult,
  TIERS,
  type Tier,
} from "../../../../shared/orchestration";

type ProviderValue = JevProvider | "off";

const PROVIDER_LABELS: Record<ProviderValue, string> = {
  off: "Off",
  openrouter: "OpenRouter",
  typesafe: "TypeSafe (Jev)",
  local: "Local server",
};

/** What the endpoint field shows when left empty. */
const ENDPOINT_HINT: Record<ProviderValue, string> = {
  off: "",
  openrouter: "https://openrouter.ai/api/v1",
  typesafe: "https://api.typesafe.ai",
  local: "http://localhost:11434/v1",
};

const MODEL_HINT: Record<ProviderValue, string> = {
  off: "",
  openrouter: "e.g. anthropic/claude-haiku-5-5",
  typesafe: "jev-latest",
  local: "e.g. qwen3:8b",
};

const POINT_COPY: Record<JudgePoint, { label: string; description: string }> = {
  "model-tier": {
    label: "Model tier",
    description: "Which tier a delegated task runs on.",
  },
  permission: {
    label: "Permissions",
    description:
      "Allow a read-only tool, or deny one plainly out of bounds. Never an irreversible action.",
  },
  report: {
    label: "Worker reports",
    description: "Whether a worker's report says its checks passed.",
  },
};

const MODE_LABELS: Record<JudgeMode, string> = {
  shadow: "Shadow",
  enforce: "Enforce",
};

const TIER_LABELS: Record<Tier, string> = {
  light: "Light",
  standard: "Standard",
  heavy: "Heavy",
};

/** Test connection's fixed question: easy, so a wrong answer means trouble. */
const SAMPLE = {
  point: "report" as const,
  question: "Did the worker's checks pass?",
  options: ["passed", "failed"],
  context:
    "Worker report: ran `bun run typecheck` (0 errors) and `bun run build` (done in 4.2s). All checks passed.",
};

/** The hosts plain http may reach; `URL.hostname` keeps IPv6's brackets. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A field that can carry an error: endpoint, model, or a point's threshold. */
type Field = "endpoint" | "model" | JudgePoint;

/** Top to bottom, so a failed save focuses the first field in the way. */
const FIELD_ORDER: Field[] = ["endpoint", "model", ...JUDGE_POINTS];

const fieldId = (field: Field) => `jev-${field}-error`;

const sameConfig = (a: JevConfig, b: JevConfig) =>
  JSON.stringify(a) === JSON.stringify(b);

const percent = (p: number) => `${Math.round(p * 100)}%`;

/** A 0-1 threshold as the percentage the field shows, without float noise. */
const thresholdText = (threshold: number) =>
  String(Number((threshold * 100).toFixed(2)));

/** The field's text as a 0-100 percentage; null when it is not one. */
function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * What stops the draft from saving, per field. Mirrors main's checks
 * (`parseJevConfig`) so the user hears about a field next to it, before the
 * round trip; main still checks everything.
 */
function validate(
  draft: JevConfig,
  typed: Partial<Record<JudgePoint, string>>,
): Partial<Record<Field, string>> {
  const issues: Partial<Record<Field, string>> = {};
  if (draft.provider) {
    const endpoint = draft.endpoint.trim();
    if (!endpoint) {
      if (draft.provider === "local")
        issues.endpoint = "Required: the local server's base URL.";
    } else {
      let url: URL | null = null;
      try {
        url = new URL(endpoint);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
        issues.endpoint = "Enter an http or https URL.";
      else if (url.username || url.password)
        issues.endpoint =
          "Leave credentials out of the URL; save the API key instead.";
      else if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
        issues.endpoint =
          "Use https, or http only on this Mac (localhost, 127.0.0.1, ::1).";
    }
    if (!draft.model.trim()) issues.model = "Required: the judge's model id.";
  }
  for (const point of JUDGE_POINTS) {
    const text = typed[point];
    if (text !== undefined && parsePercent(text) === null)
      issues[point] = "Enter a percentage from 0 to 100.";
  }
  return issues;
}

/** Which field a message from main is about, so it shows next to it. */
function fieldOf(message: string): Field | null {
  if (/threshold/i.test(message))
    return JUDGE_POINTS.find((point) => message.startsWith(point)) ?? null;
  if (/endpoint/i.test(message)) return "endpoint";
  if (/model/i.test(message) && !TIERS.some((tier) => message.startsWith(tier)))
    return "model";
  return null;
}

/** What Test connection says about one answer. */
function describeResult(result: JudgeResult) {
  if (result.source === "judge")
    return {
      failed: false,
      text: `Answered “${result.choice}”, ${percent(result.p)} sure.`,
    };
  if (result.source === "off") return { failed: false, text: "Jev is off." };
  return { failed: true, text: result.error ?? "The judge failed." };
}

/**
 * How often Jev's choice matched what was done in the end, over the answers
 * whose outcome is known. Null when there are none.
 */
function agreement(log: JudgeLogEntry[]) {
  const known = log.filter(
    (entry) =>
      entry.choice !== null && entry.outcome !== null && !entry.decided,
  );
  if (known.length === 0) return null;
  const agreed = known.filter((entry) => entry.choice === entry.outcome).length;
  return { agreed, total: known.length };
}

/** A field's error, under its control; the field points at it by id. */
function FieldError({ id, message }: { id: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p
      id={id}
      className="text-destructive mt-1 max-w-64 text-right text-[12px] leading-snug"
    >
      {message}
    </p>
  );
}

/**
 * Settings › Agents › Jev: the cheap judge the lead asks before its own
 * model (FE-87).
 *
 * NOTE: The key goes to main through `setKey` and never comes back: the page
 * only learns whether one is kept. The field clears once main has it.
 *
 * NOTE: Test connection asks with the SAVED config, so it is off while the
 * page holds unsaved changes. Testing a draft would prove nothing about what
 * the lead will use. Its answer is dropped as soon as the config or the key
 * changes, so it never vouches for settings it did not test (FE-91).
 *
 * NOTE: A threshold field holds its own text while it is typed in, so
 * clearing it to type a new number leaves it empty instead of snapping to 0.
 * The text is checked on blur and on Save; a valid number reaches the draft
 * as it is typed (FE-91).
 */
export function JevSection() {
  const surface = window.desktop?.jev;
  const [saved, setSaved] = useState<JevState | null>(null);
  const [draft, setDraft] = useState<JevConfig | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<{
    failed: boolean;
    text: string;
  } | null>(null);
  const [log, setLog] = useState<JudgeLogEntry[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  // Reading the settings at all failed: the page has nothing to edit.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // A failed save main did not tie to a field.
  const [saveError, setSaveError] = useState<string | null>(null);
  // A failed save main tied to a field, shown there until the draft changes.
  const [serverErrors, setServerErrors] = useState<
    Partial<Record<Field, string>>
  >({});
  // Threshold fields mid-edit, as typed (percent).
  const [typed, setTyped] = useState<Partial<Record<JudgePoint, string>>>({});
  // Fields left at least once, and whether Save was pressed: errors show
  // only after one of those, never while the user is still typing.
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  const [attempted, setAttempted] = useState(false);

  // The draft as last rendered, so a broadcast can tell an edit in progress
  // from a page that merely shows the saved config.
  const draftRef = useRef<JevConfig | null>(null);
  const savedRef = useRef<JevState | null>(null);
  const typedRef = useRef(typed);
  draftRef.current = draft;
  savedRef.current = saved;
  typedRef.current = typed;
  const fieldRefs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});

  const resetEdits = useCallback(() => {
    setTyped({});
    setTouched(new Set());
    setAttempted(false);
    setServerErrors({});
    setSaveError(null);
  }, []);

  const adopt = useCallback(
    (next: JevState) => {
      setSaved(next);
      setDraft(next.config);
      setOutcome(null);
      resetEdits();
    },
    [resetEdits],
  );

  const readLog = useCallback(async () => {
    if (!surface) return;
    try {
      setLog(await surface.log());
      setLogError(null);
    } catch (failure) {
      setLogError(ipcMessage(failure, "Could not read Jev's log."));
    }
  }, [surface]);

  useEffect(() => {
    if (!surface) return;
    surface
      .get()
      .then(adopt)
      .catch((failure: unknown) =>
        setLoadError(ipcMessage(failure, "Could not read Jev's settings.")),
      );
    void readLog();
    // Another window saved: take its config, unless this one is mid-edit.
    return surface.onChange((next) => {
      const current = savedRef.current;
      const editing =
        Object.keys(typedRef.current).length > 0 ||
        (!!current &&
          !!draftRef.current &&
          !sameConfig(draftRef.current, current.config));
      if (editing) {
        setSaved(next);
        setOutcome(null);
      } else adopt(next);
    });
  }, [surface, adopt, readLog]);

  const tierModels = useMemo(() => allModels(), []);

  /** Run a call to main; the failure's message, or null when it worked. */
  async function run(
    action: () => Promise<JevState>,
    fallback: string,
    then: (next: JevState) => void,
  ): Promise<string | null> {
    setBusy(true);
    try {
      then(await action());
      return null;
    } catch (failure) {
      return ipcMessage(failure, fallback);
    } finally {
      setBusy(false);
    }
  }

  /** The key changed: keep the draft, drop a test made with the old key. */
  const adoptKey = (next: JevState) => {
    setSaved(next);
    setOutcome(null);
  };

  /** Focus a field once the render that shows its error has landed. */
  const focusField = (field: Field) =>
    requestAnimationFrame(() => fieldRefs.current[field]?.focus());

  async function test() {
    if (!surface) return;
    setTesting(true);
    setOutcome(null);
    try {
      setOutcome(describeResult(await surface.test(SAMPLE)));
    } catch (failure) {
      setOutcome({
        failed: true,
        text: ipcMessage(failure, "Could not ask the judge."),
      });
    } finally {
      setTesting(false);
      void readLog();
    }
  }

  if (!surface)
    return (
      <SettingsPage
        title="Jev"
        description="Jev runs in the desktop app."
        sections={[]}
      />
    );

  if (!saved || !draft)
    return (
      <SettingsPage
        title="Jev"
        description="A cheap judge that answers small questions so the lead's model is asked only when Jev is unsure."
        sections={[
          {
            title: "Judge",
            hideTitle: true,
            content: loadError ? (
              <p role="alert" className="text-destructive text-[13px]">
                {loadError}
              </p>
            ) : (
              <SettingsCard>
                <ListSkeleton
                  label="Reading Jev's settings"
                  rows={4}
                  icon={false}
                  className="py-3"
                />
              </SettingsCard>
            ),
          },
        ]}
      />
    );

  const provider: ProviderValue = draft.provider ?? "off";
  const dirty = !sameConfig(draft, saved.config);
  const needsKey =
    draft.provider === "openrouter" || draft.provider === "typesafe";
  const issues = validate(draft, typed);
  /** The error a field shows now: main's, or ours once it may be shown. */
  const errorOf = (field: Field): string | null =>
    serverErrors[field] ??
    (attempted || touched.has(field) ? (issues[field] ?? null) : null);
  const touch = (field: Field) =>
    setTouched((current) => new Set(current).add(field));
  /** ARIA for a field that may carry an error. */
  const fieldAria = (field: Field) => {
    const error = errorOf(field);
    return {
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? fieldId(field) : undefined,
    };
  };

  const update = (change: Partial<JevConfig>) => {
    setDraft({ ...draft, ...change });
    setOutcome(null);
    setServerErrors({});
    setSaveError(null);
  };
  const setPoint = (
    point: JudgePoint,
    change: Partial<JevConfig["points"][JudgePoint]>,
  ) =>
    update({
      points: {
        ...draft.points,
        [point]: { ...draft.points[point], ...change },
      },
    });
  const setTier = (tier: Tier, change: Partial<JevConfig["tiers"][Tier]>) =>
    update({
      tiers: { ...draft.tiers, [tier]: { ...draft.tiers[tier], ...change } },
    });

  async function save() {
    if (!surface || !draft) return;
    setAttempted(true);
    const first = FIELD_ORDER.find((field) => issues[field]);
    if (first) {
      focusField(first);
      return;
    }
    const failure = await run(
      () => surface.set(draft),
      "Could not save.",
      adopt,
    );
    if (!failure) return;
    const field = fieldOf(failure);
    if (field) {
      setServerErrors({ [field]: failure });
      focusField(field);
    } else setSaveError(failure);
  }

  async function saveKey() {
    if (!surface) return;
    const failure = await run(
      () => surface.setKey(key),
      "Could not keep the key.",
      adoptKey,
    );
    setKeyError(failure);
    if (!failure) setKey("");
  }

  async function forgetKey() {
    if (!surface) return;
    setKeyError(
      await run(
        () => surface.setKey(null),
        "Could not forget the key.",
        adoptKey,
      ),
    );
  }

  // A saved provider that needs a key and has none cannot answer: say so
  // under the key field, without blocking Save (the key is kept per provider,
  // so it is saved after the provider).
  const keyMissing =
    !dirty && needsKey && !saved.hasKey
      ? "Required: the judge cannot answer without a key."
      : null;

  const sections: SettingsSectionSpec[] = [
    {
      title: "Judge",
      rows: [
        {
          label: "Provider",
          description:
            provider === "off"
              ? "Off: the lead decides everything."
              : provider === "local"
                ? "An OpenAI-compatible server you run: Ollama, llama.cpp or LM Studio."
                : provider === "typesafe"
                  ? "TypeSafe's Jev, a model built to answer with calibrated probabilities."
                  : "Any model on OpenRouter, read through its logprobs.",
          keywords:
            "provider openrouter typesafe jev local ollama llama.cpp lm studio off",
          control: (
            <Select
              value={provider}
              onValueChange={(value) =>
                update({
                  provider: value === "off" ? null : (value as JevProvider),
                })
              }
            >
              <SelectTrigger aria-label="Jev provider" className="min-w-36">
                <SelectValue>
                  {(value: ProviderValue) => PROVIDER_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(["off", ...JEV_PROVIDERS] as ProviderValue[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {PROVIDER_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        },
        ...(provider === "off"
          ? []
          : [
              {
                label:
                  provider === "local" ? "Endpoint (required)" : "Endpoint",
                description:
                  provider === "local"
                    ? "The server's base URL, ending in /v1. Plain http only on this Mac."
                    : "Leave empty for the provider's own. Changing it forgets the key.",
                keywords: "endpoint url base server",
                control: (
                  <div className="flex flex-col items-end">
                    <Input
                      ref={(node) => {
                        fieldRefs.current.endpoint = node;
                      }}
                      aria-label="Jev endpoint"
                      aria-required={provider === "local" ? true : undefined}
                      {...fieldAria("endpoint")}
                      className="w-64"
                      placeholder={ENDPOINT_HINT[provider]}
                      value={draft.endpoint}
                      onChange={(event) =>
                        update({ endpoint: event.target.value })
                      }
                      onBlur={() => touch("endpoint")}
                    />
                    <FieldError
                      id={fieldId("endpoint")}
                      message={errorOf("endpoint")}
                    />
                  </div>
                ),
              },
              {
                label: "Model (required)",
                description: "The judge's model id at the provider.",
                keywords: "model id judge",
                control: (
                  <div className="flex flex-col items-end">
                    <Input
                      ref={(node) => {
                        fieldRefs.current.model = node;
                      }}
                      aria-label="Jev model"
                      aria-required
                      {...fieldAria("model")}
                      className="w-64"
                      placeholder={MODEL_HINT[provider]}
                      value={draft.model}
                      onChange={(event) =>
                        update({ model: event.target.value })
                      }
                      onBlur={() => touch("model")}
                    />
                    <FieldError
                      id={fieldId("model")}
                      message={errorOf("model")}
                    />
                  </div>
                ),
              },
              {
                label: needsKey ? "API key (required)" : "API key",
                description: saved.hasKey
                  ? "Kept encrypted on this Mac for this provider and endpoint only. It never reaches an agent or a log."
                  : needsKey
                    ? "Kept encrypted on this Mac for the saved provider and endpoint, never shown again."
                    : "Optional for a local server.",
                keywords: "api key token secret keychain",
                control: (
                  <div className="flex flex-col items-end">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label="Jev API key"
                        aria-required={
                          needsKey && !saved.hasKey ? true : undefined
                        }
                        aria-invalid={keyError || keyMissing ? true : undefined}
                        aria-describedby={
                          keyError || keyMissing ? "jev-key-error" : undefined
                        }
                        type="password"
                        autoComplete="off"
                        className="w-44"
                        placeholder={saved.hasKey ? "••••••••" : "Paste a key"}
                        value={key}
                        onChange={(event) => {
                          setKey(event.target.value);
                          setKeyError(null);
                        }}
                      />
                      <Button
                        size="lg"
                        className={SETTINGS_BUTTON}
                        variant="outline"
                        disabled={busy || !key.trim()}
                        onClick={() => void saveKey()}
                      >
                        Save key
                      </Button>
                      {saved.hasKey && (
                        <Button
                          size="lg"
                          className={SETTINGS_BUTTON}
                          variant="outline"
                          disabled={busy}
                          onClick={() => void forgetKey()}
                        >
                          Forget
                        </Button>
                      )}
                    </div>
                    <FieldError
                      id="jev-key-error"
                      message={keyError ?? keyMissing}
                    />
                  </div>
                ),
              },
            ]),
      ],
    },
    {
      title: "Decision points",
      rows: JUDGE_POINTS.map((point) => ({
        label: POINT_COPY[point].label,
        description: `${POINT_COPY[point].description} ${
          draft.points[point].mode === "shadow"
            ? "Shadow: Jev answers and logs, the lead still decides."
            : `Enforce: Jev decides when it is at least ${percent(draft.points[point].threshold)} sure.`
        }`,
        keywords: "threshold shadow enforce mode point percent",
        control: (
          <div className="flex flex-col items-end">
            <div className="flex items-center gap-2">
              <Select
                value={draft.points[point].mode}
                onValueChange={(value) =>
                  setPoint(point, { mode: value as JudgeMode })
                }
              >
                <SelectTrigger
                  aria-label={`${POINT_COPY[point].label} mode`}
                  className="min-w-24"
                >
                  <SelectValue>
                    {(value: JudgeMode) => MODE_LABELS[value]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(["shadow", "enforce"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {MODE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Input
                  ref={(node) => {
                    fieldRefs.current[point] = node;
                  }}
                  aria-label={`${POINT_COPY[point].label} threshold, percent`}
                  {...fieldAria(point)}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={1}
                  className="w-16 text-right tabular-nums"
                  value={
                    typed[point] ?? thresholdText(draft.points[point].threshold)
                  }
                  onChange={(event) => {
                    const text = event.target.value;
                    setTyped((current) => ({ ...current, [point]: text }));
                    const value = parsePercent(text);
                    if (value !== null)
                      setPoint(point, { threshold: value / 100 });
                    else {
                      setServerErrors({});
                      setOutcome(null);
                    }
                  }}
                  onBlur={() => {
                    touch(point);
                    // A valid entry goes back to showing the draft's value,
                    // normalised; an invalid one stays to be fixed.
                    if (parsePercent(typed[point] ?? "") !== null)
                      setTyped(({ [point]: _done, ...rest }) => rest);
                  }}
                />
                <span
                  aria-hidden="true"
                  className="text-muted-foreground text-[13px]"
                >
                  %
                </span>
              </div>
            </div>
            <FieldError id={fieldId(point)} message={errorOf(point)} />
          </div>
        ),
      })),
    },
    {
      title: "Tiers",
      rows: TIERS.map((tier) => {
        const current = draft.tiers[tier];
        const options = tierModels.filter(
          (model) => !model.legacy || model.id === current.model,
        );
        return {
          label: TIER_LABELS[tier],
          description:
            tier === "light"
              ? "Small, well-bounded tasks."
              : tier === "standard"
                ? "Most tasks."
                : "Hard or wide-reaching tasks.",
          keywords: "tier model light standard heavy effort",
          control: (
            <div className="flex items-center gap-2">
              <Select
                value={current.model}
                onValueChange={(value) => {
                  const model = tierModels.find((m) => m.id === value);
                  if (model)
                    setTier(tier, { model: model.id, agent: model.agent });
                }}
              >
                <SelectTrigger
                  aria-label={`${TIER_LABELS[tier]} tier model`}
                  className="min-w-36"
                >
                  <SelectValue>
                    {(value: string) =>
                      tierModels.find((m) => m.id === value)?.label ?? value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {options.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={current.effort ?? "default"}
                onValueChange={(value) =>
                  setTier(tier, {
                    effort: value === "default" ? null : (value as Effort),
                  })
                }
              >
                <SelectTrigger
                  aria-label={`${TIER_LABELS[tier]} tier effort`}
                  className="min-w-24"
                >
                  <SelectValue>
                    {(value: string) =>
                      value === "default"
                        ? "Default"
                        : EFFORT_LABELS[value as Effort]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  {EFFORTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {EFFORT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ),
        };
      }),
    },
    {
      title: "Save",
      hideTitle: true,
      rows: [
        {
          label: dirty ? "Unsaved changes" : "Saved",
          description: dirty
            ? "Jev keeps using the saved settings until you save."
            : "Jev uses these settings from the next question.",
          keywords: "save apply",
          control: (
            <div className="flex flex-col items-end">
              <div className="flex items-center gap-2">
                {(dirty || Object.keys(typed).length > 0) && (
                  <Button
                    size="lg"
                    className={SETTINGS_BUTTON}
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setDraft(saved.config);
                      setOutcome(null);
                      resetEdits();
                    }}
                  >
                    Discard
                  </Button>
                )}
                <Button
                  size="lg"
                  className={SETTINGS_BUTTON}
                  disabled={busy || (!dirty && Object.keys(typed).length === 0)}
                  aria-describedby={saveError ? "jev-save-error" : undefined}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </div>
              {saveError && (
                <p
                  id="jev-save-error"
                  role="alert"
                  className="text-destructive mt-1 max-w-64 text-right text-[12px] leading-snug"
                >
                  {saveError}
                </p>
              )}
            </div>
          ),
        },
      ],
    },
    {
      title: "Check",
      rows: [
        {
          label: "Test connection",
          description: dirty
            ? "Save first: the test uses the saved settings."
            : `Asks “${SAMPLE.question}” about a sample report.`,
          keywords: "test connection try ask sample probability",
          control: (
            <div className="flex flex-col items-end">
              <Button
                size="lg"
                className={SETTINGS_BUTTON}
                variant="outline"
                disabled={testing || dirty || !saved.config.provider}
                aria-busy={testing}
                aria-describedby="jev-test-result"
                onClick={() => void test()}
              >
                {testing && (
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                )}
                {testing ? "Asking…" : "Test connection"}
              </Button>
              {/* Always mounted: a live region must exist before its text
                  changes, or VoiceOver does not read the answer. */}
              <p
                id="jev-test-result"
                role="status"
                aria-live="polite"
                className={cn(
                  "mt-1 max-w-64 text-right text-[12px] leading-snug empty:mt-0",
                  outcome?.failed
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {outcome?.text ?? ""}
              </p>
            </div>
          ),
        },
        {
          label: "Agreement with the lead",
          description:
            "Of the answers the lead settled, how often Jev chose the same.",
          keywords: "shadow log agreement accuracy rate calibration",
          control: <AgreementValue log={log} error={logError} />,
        },
      ],
    },
  ];

  return (
    <SettingsPage
      title="Jev"
      description="A cheap judge that answers small questions so the lead's model is asked only when Jev is unsure."
      sections={sections}
    />
  );
}

function AgreementValue({
  log,
  error,
}: {
  log: JudgeLogEntry[] | null;
  error: string | null;
}) {
  // A failed read is not an empty log: say it failed.
  if (error)
    return (
      <span className="text-destructive max-w-64 text-right text-[13px]">
        {error}
      </span>
    );
  if (!log) return <TextSkeleton label="Reading Jev's log" />;
  const rate = agreement(log);
  return (
    <span className="text-muted-foreground text-[13px] tabular-nums">
      {rate
        ? `${percent(rate.agreed / rate.total)} of ${rate.total}`
        : log.length
          ? "Nothing settled yet"
          : "No answers yet"}
    </span>
  );
}
