// Run with `bun test ./electron/main/terminal/usage-forecast.test.ts`.
//
// The forecast warns only when both the recent and the average pace run out
// at least the margin before the reset (FE-181/D4), and stays quiet early in
// a window or at low usage. Samples keep one window at a time.
//
// NOTE: Lives beside the main-process tests so `test:unit` finds it; the
// module under test is in `shared/` and stays free of Node.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  appendSample,
  DEFAULT_USAGE_FORECAST_SETTINGS,
  type ForecastWindow,
  forecastOf,
  historyKey,
  readUsageForecastSettings,
  type UsageSample,
  WINDOW_MINUTES,
  windowOfMinutes,
} from "../../../shared/usage-forecast";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 28, 12);
const settings = DEFAULT_USAGE_FORECAST_SETTINGS;

/**
 * Samples every `step` minutes over the last `minutes`, rising linearly from
 * `from` to `to` percent, all in the window that resets at `resetsAt`.
 */
function rising(
  from: number,
  to: number,
  minutes: number,
  resetsAt: number,
  step = 5,
): UsageSample[] {
  const samples: UsageSample[] = [];
  for (let m = minutes; m >= 0; m -= step) {
    const progress = (minutes - m) / minutes;
    samples.push({
      at: NOW - m * MINUTE,
      usedPercent: from + (to - from) * progress,
      resetsAt,
    });
  }
  return samples;
}

/** The reset of a window that started `ago` milliseconds before {@link NOW}. */
function resetOf(ago: number, window: ForecastWindow = "five-hour"): number {
  return NOW - ago + WINDOW_MINUTES[window] * MINUTE;
}

function near(actual: number, expected: number, tolerance: number) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );
}

describe("forecastOf", () => {
  test("50% after an hour, rising steadily, runs out three hours short", () => {
    const resetsAt = resetOf(HOUR);
    const forecast = forecastOf(
      rising(0, 50, 60, resetsAt),
      "five-hour",
      NOW,
      settings,
    );
    assert.ok(forecast);
    assert.equal(forecast.usedPercent, 50);
    assert.equal(forecast.resetsAt, resetsAt);
    near(forecast.ratePercentPerHour, 50, 0.01);
    near(forecast.exhaustAt, NOW + HOUR, MINUTE);
    near(forecast.shortByMs, 3 * HOUR, MINUTE);
  });

  test("stays quiet under 25% used", () => {
    const resetsAt = resetOf(HOUR);
    assert.equal(
      forecastOf(rising(0, 10, 60, resetsAt), "five-hour", NOW, settings),
      null,
    );
  });

  test("stays quiet in the first 15 minutes of a window", () => {
    const resetsAt = resetOf(10 * MINUTE);
    assert.equal(
      forecastOf(rising(0, 40, 10, resetsAt, 2), "five-hour", NOW, settings),
      null,
    );
  });

  test("stays quiet with fewer than 3 samples in the lookback", () => {
    const resetsAt = resetOf(HOUR);
    const samples: UsageSample[] = [
      // Outside the 60-minute lookback.
      { at: NOW - 90 * MINUTE, usedPercent: 0, resetsAt },
      { at: NOW - 30 * MINUTE, usedPercent: 25, resetsAt },
      { at: NOW, usedPercent: 50, resetsAt },
    ];
    assert.equal(forecastOf(samples, "five-hour", NOW, settings), null);
  });

  test("stays quiet after a short burst on a slow window", () => {
    // 40% after three hours averages 13%/h, which lasts past the reset two
    // hours away; the last half hour alone (60%/h) would not.
    const resetsAt = resetOf(3 * HOUR);
    const samples: UsageSample[] = [
      { at: NOW - 2 * HOUR, usedPercent: 10, resetsAt },
      ...rising(10, 40, 30, resetsAt),
    ];
    assert.equal(forecastOf(samples, "five-hour", NOW, settings), null);
  });

  test("stays quiet when usage is flat", () => {
    const resetsAt = resetOf(HOUR);
    assert.equal(
      forecastOf(rising(60, 60, 60, resetsAt), "five-hour", NOW, settings),
      null,
    );
  });

  test("warns only when the run-out lands before the margin", () => {
    // Four hours in at 86%, one hour to go. The recent pace (30%/h) runs out
    // in 28 minutes, the average (21.5%/h) in 39: the later one counts, 21
    // minutes before the reset.
    const resetsAt = resetOf(4 * HOUR);
    const samples = rising(56, 86, 60, resetsAt);
    assert.equal(forecastOf(samples, "five-hour", NOW, settings), null);
    const forecast = forecastOf(samples, "five-hour", NOW, {
      ...settings,
      marginMinutes: 15,
    });
    assert.ok(forecast);
    near(forecast.ratePercentPerHour, 30, 0.01);
    near(forecast.exhaustAt, NOW + (14 / 21.5) * HOUR, 1000);
    near(forecast.shortByMs, resetsAt - forecast.exhaustAt, 0);
  });

  test("an exhausted window runs out now", () => {
    const resetsAt = resetOf(2 * HOUR);
    const forecast = forecastOf(
      rising(70, 100, 60, resetsAt),
      "five-hour",
      NOW,
      settings,
    );
    assert.ok(forecast);
    assert.equal(forecast.exhaustAt, NOW);
    assert.equal(forecast.shortByMs, 3 * HOUR);
  });

  test("returns null without a usable reset or when switched off", () => {
    const resetsAt = resetOf(HOUR);
    const samples = rising(0, 50, 60, resetsAt);
    assert.equal(forecastOf([], "five-hour", NOW, settings), null);
    assert.equal(
      forecastOf(
        samples.map((sample) => ({ ...sample, resetsAt: null })),
        "five-hour",
        NOW,
        settings,
      ),
      null,
    );
    assert.equal(forecastOf(samples, "five-hour", resetsAt, settings), null);
    assert.equal(
      forecastOf(samples, "five-hour", NOW, { ...settings, enabled: false }),
      null,
    );
    assert.equal(
      forecastOf(samples, "five-hour", NOW, { ...settings, fiveHour: false }),
      null,
    );
    assert.ok(
      forecastOf(samples, "five-hour", NOW, { ...settings, weekly: false }),
    );
  });

  test("a weekly window measures its pace over the last day", () => {
    // Two days in at 60%: both paces (30%/day) run out in about 1.3 days,
    // well before the reset five days away.
    const resetsAt = resetOf(48 * HOUR, "weekly");
    const forecast = forecastOf(
      rising(30, 60, 24 * 60, resetsAt, 60),
      "weekly",
      NOW,
      settings,
    );
    assert.ok(forecast);
    near(forecast.ratePercentPerHour, 30 / 24, 0.001);
    near(forecast.exhaustAt, NOW + (40 / 30) * 24 * HOUR, MINUTE);
  });
});

describe("appendSample", () => {
  const resetsAt = NOW + 4 * HOUR;

  test("returns a new array and clamps the percentage", () => {
    const samples: UsageSample[] = [];
    const next = appendSample(
      samples,
      { at: NOW, usedPercent: 140, resetsAt },
      "five-hour",
    );
    assert.notEqual(next, samples);
    assert.equal(samples.length, 0);
    assert.deepEqual(next, [{ at: NOW, usedPercent: 100, resetsAt }]);
    const low = appendSample(
      next,
      { at: NOW + MINUTE, usedPercent: -5, resetsAt },
      "five-hour",
    );
    assert.equal(low.at(-1)?.usedPercent, 0);
  });

  test("a moved reset starts a new window", () => {
    let samples: UsageSample[] = [];
    for (let i = 0; i < 5; i++)
      samples = appendSample(
        samples,
        { at: NOW + i * 5 * MINUTE, usedPercent: 20 + i, resetsAt },
        "five-hour",
      );
    const next = appendSample(
      samples,
      { at: NOW + HOUR, usedPercent: 2, resetsAt: resetsAt + 5 * HOUR },
      "five-hour",
    );
    assert.deepEqual(next, [
      { at: NOW + HOUR, usedPercent: 2, resetsAt: resetsAt + 5 * HOUR },
    ]);
  });

  test("a jittered reset keeps the window", () => {
    let samples: UsageSample[] = [];
    const jitter = [0, 20_000, -45_000, 2 * MINUTE, -2 * MINUTE];
    jitter.forEach((offset, i) => {
      samples = appendSample(
        samples,
        {
          at: NOW + i * 5 * MINUTE,
          usedPercent: 30 + i,
          resetsAt: resetsAt + offset,
        },
        "five-hour",
      );
    });
    assert.equal(samples.length, 5);
  });

  test("skips a repeat under a minute old", () => {
    const first = appendSample(
      [],
      { at: NOW, usedPercent: 30, resetsAt },
      "five-hour",
    );
    const repeat = appendSample(
      first,
      { at: NOW + 30_000, usedPercent: 30, resetsAt },
      "five-hour",
    );
    assert.equal(repeat.length, 1);
    const changed = appendSample(
      first,
      { at: NOW + 30_000, usedPercent: 31, resetsAt },
      "five-hour",
    );
    assert.equal(changed.length, 2);
    const later = appendSample(
      first,
      { at: NOW + 61_000, usedPercent: 30, resetsAt },
      "five-hour",
    );
    assert.equal(later.length, 2);
  });

  test("keeps a day of five-hour samples", () => {
    let samples: UsageSample[] = [];
    for (let m = 0; m <= 30 * 60; m += 30)
      samples = appendSample(
        samples,
        { at: NOW + m * MINUTE, usedPercent: m % 100, resetsAt: null },
        "five-hour",
      );
    const last = samples.at(-1);
    assert.ok(last);
    assert.equal(last.at, NOW + 30 * HOUR);
    assert.ok(samples.every((sample) => sample.at >= last.at - 24 * HOUR));
    assert.equal(samples[0].at, last.at - 24 * HOUR);
  });

  test("thins weekly samples to one per 10 minutes, keeping the newest", () => {
    const weeklyReset = NOW + 7 * 24 * HOUR;
    let samples: UsageSample[] = [];
    for (let m = 0; m <= 60; m++)
      samples = appendSample(
        samples,
        { at: NOW + m * MINUTE, usedPercent: m / 2, resetsAt: weeklyReset },
        "weekly",
      );
    assert.deepEqual(
      samples.map((sample) => (sample.at - NOW) / MINUTE),
      [0, 10, 20, 30, 40, 50, 60],
    );
  });

  test("keeps seven days of weekly samples", () => {
    let samples: UsageSample[] = [];
    for (let h = 0; h <= 9 * 24; h++)
      samples = appendSample(
        samples,
        { at: NOW + h * HOUR, usedPercent: 10, resetsAt: null },
        "weekly",
      );
    const last = samples.at(-1);
    assert.ok(last);
    assert.equal(samples[0].at, last.at - 7 * 24 * HOUR);
    assert.equal(samples.length, 7 * 24 + 1);
  });
});

describe("settings and keys", () => {
  test("garbage falls back to the defaults, field by field", () => {
    for (const value of [undefined, null, "on", 42, [], [true]])
      assert.deepEqual(
        readUsageForecastSettings(value),
        DEFAULT_USAGE_FORECAST_SETTINGS,
      );
    assert.deepEqual(
      readUsageForecastSettings({
        enabled: "yes",
        fiveHour: 0,
        weekly: false,
        marginMinutes: 45,
      }),
      { ...DEFAULT_USAGE_FORECAST_SETTINGS, weekly: false },
    );
    assert.deepEqual(
      readUsageForecastSettings({
        enabled: false,
        fiveHour: false,
        weekly: true,
        marginMinutes: 120,
      }),
      { enabled: false, fiveHour: false, weekly: true, marginMinutes: 120 },
    );
    assert.equal(
      readUsageForecastSettings({ marginMinutes: Number.NaN }).marginMinutes,
      30,
    );
  });

  test("the defaults are not shared by reference", () => {
    const read = readUsageForecastSettings(null);
    read.enabled = false;
    assert.equal(DEFAULT_USAGE_FORECAST_SETTINGS.enabled, true);
  });

  test("windowOfMinutes matches by range", () => {
    assert.equal(windowOfMinutes(300), "five-hour");
    assert.equal(windowOfMinutes(360), "five-hour");
    assert.equal(windowOfMinutes(10080), "weekly");
    assert.equal(windowOfMinutes(10000), "weekly");
    assert.equal(windowOfMinutes(1440), null);
    assert.equal(windowOfMinutes(0), null);
    assert.equal(windowOfMinutes(Number.NaN), null);
  });

  test("historyKey joins agent and window", () => {
    assert.equal(historyKey("codex", "weekly"), "codex:weekly");
  });
});
