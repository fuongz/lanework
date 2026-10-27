import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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

const sameConfig = (a: JevConfig, b: JevConfig) =>
  JSON.stringify(a) === JSON.stringify(b);

const percent = (p: number) => `${Math.round(p * 100)}%`;

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

/**
 * Settings › Agents › Jev: the cheap judge the lead asks before its own
 * model (FE-87).
 *
 * NOTE: The key goes to main through `setKey` and never comes back: the page
 * only learns whether one is kept. The field clears once main has it.
 *
 * NOTE: Test connection asks with the SAVED config, so it is off while the
 * page holds unsaved changes. Testing a draft would prove nothing about what
 * the lead will use.
 */
export function JevSection() {
  const surface = window.desktop?.jev;
  const [saved, setSaved] = useState<JevState | null>(null);
  const [draft, setDraft] = useState<JevConfig | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<JudgeResult | null>(null);
  const [log, setLog] = useState<JudgeLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The draft as last rendered, so a broadcast can tell an edit in progress
  // from a page that merely shows the saved config.
  const draftRef = useRef<JevConfig | null>(null);
  const savedRef = useRef<JevState | null>(null);
  draftRef.current = draft;
  savedRef.current = saved;

  const adopt = useCallback((next: JevState) => {
    setSaved(next);
    setDraft(next.config);
  }, []);

  const readLog = useCallback(async () => {
    if (!surface) return;
    setLog(await surface.log().catch(() => []));
  }, [surface]);

  useEffect(() => {
    if (!surface) return;
    surface
      .get()
      .then(adopt)
      .catch((failure: unknown) =>
        setError(ipcMessage(failure, "Could not read Jev's settings.")),
      );
    void readLog();
    // Another window saved: take its config, unless this one is mid-edit.
    return surface.onChange((next) => {
      const current = savedRef.current;
      const editing =
        !!current &&
        !!draftRef.current &&
        !sameConfig(draftRef.current, current.config);
      setSaved(next);
      if (!editing) setDraft(next.config);
    });
  }, [surface, adopt, readLog]);

  const tierModels = useMemo(() => allModels(), []);

  async function run(action: () => Promise<JevState>, fallback: string) {
    setBusy(true);
    try {
      adopt(await action());
      setError(null);
      return true;
    } catch (failure) {
      setError(ipcMessage(failure, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!surface) return;
    setTesting(true);
    try {
      setResult(await surface.test(SAMPLE));
      setError(null);
    } catch (failure) {
      setResult(null);
      setError(ipcMessage(failure, "Could not ask the judge."));
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
            content: error ? (
              <p role="alert" className="text-destructive text-[13px]">
                {error}
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
  const update = (change: Partial<JevConfig>) =>
    setDraft({ ...draft, ...change });
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
                label: "Endpoint",
                description:
                  provider === "local"
                    ? "Required: the server's base URL, ending in /v1. Plain http only on this Mac."
                    : "Leave empty for the provider's own. Changing it forgets the key.",
                keywords: "endpoint url base server",
                control: (
                  <Input
                    aria-label="Jev endpoint"
                    className="w-64"
                    placeholder={ENDPOINT_HINT[provider]}
                    value={draft.endpoint}
                    onChange={(event) =>
                      update({ endpoint: event.target.value })
                    }
                  />
                ),
              },
              {
                label: "Model",
                description: "The judge's model id at the provider.",
                keywords: "model id judge",
                control: (
                  <Input
                    aria-label="Jev model"
                    className="w-64"
                    placeholder={MODEL_HINT[provider]}
                    value={draft.model}
                    onChange={(event) => update({ model: event.target.value })}
                  />
                ),
              },
              {
                label: "API key",
                description: saved.hasKey
                  ? "Kept encrypted on this Mac for this provider and endpoint only. It never reaches an agent or a log."
                  : needsKey
                    ? "Required. Kept encrypted on this Mac for the saved provider and endpoint, never shown again."
                    : "Optional for a local server.",
                keywords: "api key token secret keychain",
                control: (
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Jev API key"
                      type="password"
                      autoComplete="off"
                      className="w-44"
                      placeholder={saved.hasKey ? "••••••••" : "Paste a key"}
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                    />
                    <Button
                      size="lg"
                      className={SETTINGS_BUTTON}
                      variant="outline"
                      disabled={busy || !key.trim()}
                      onClick={() =>
                        void run(
                          () => surface.setKey(key),
                          "Could not keep the key.",
                        ).then((ok) => ok && setKey(""))
                      }
                    >
                      Save key
                    </Button>
                    {saved.hasKey && (
                      <Button
                        size="lg"
                        className={SETTINGS_BUTTON}
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => surface.setKey(null),
                            "Could not forget the key.",
                          )
                        }
                      >
                        Forget
                      </Button>
                    )}
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
            : `Enforce: Jev decides at ${percent(draft.points[point].threshold)} or more.`
        }`,
        keywords: "threshold shadow enforce mode point",
        control: (
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
            <Input
              aria-label={`${POINT_COPY[point].label} threshold`}
              type="number"
              min={0}
              max={1}
              step={0.01}
              className="w-20"
              value={draft.points[point].threshold}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  setPoint(point, {
                    threshold: Math.min(1, Math.max(0, value)),
                  });
              }}
            />
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
            <div className="flex items-center gap-2">
              {dirty && (
                <Button
                  size="lg"
                  className={SETTINGS_BUTTON}
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDraft(saved.config)}
                >
                  Discard
                </Button>
              )}
              <Button
                size="lg"
                className={SETTINGS_BUTTON}
                disabled={busy || !dirty}
                onClick={() =>
                  void run(() => surface.set(draft), "Could not save.")
                }
              >
                Save
              </Button>
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
            : result
              ? result.source === "judge"
                ? `Answered “${result.choice}” with p = ${result.p.toFixed(2)}.`
                : result.source === "off"
                  ? "Jev is off."
                  : (result.error ?? "The judge failed.")
              : `Asks “${SAMPLE.question}” about a sample report.`,
          keywords: "test connection try ask sample probability",
          control: (
            <Button
              size="lg"
              className={SETTINGS_BUTTON}
              variant="outline"
              disabled={testing || dirty || !saved.config.provider}
              aria-busy={testing}
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
          ),
        },
        {
          label: "Agreement with the lead",
          description:
            "Of the answers the lead settled, how often Jev chose the same.",
          keywords: "shadow log agreement accuracy rate calibration",
          control: <AgreementValue log={log} />,
        },
      ],
    },
  ];

  if (error)
    sections.push({
      title: "Problem",
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });

  return (
    <SettingsPage
      title="Jev"
      description="A cheap judge that answers small questions so the lead's model is asked only when Jev is unsure."
      sections={sections}
    />
  );
}

function AgreementValue({ log }: { log: JudgeLogEntry[] | null }) {
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
