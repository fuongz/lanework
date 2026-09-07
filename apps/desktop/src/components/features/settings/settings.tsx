import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field";
import { Switch } from "#/components/ui/switch";
import { usePreferences } from "#/stores/preferences";
import type { AppInfo } from "../../../../shared/desktop";
export function Settings() {
  const compact = usePreferences((state) => state.compact);
  const setCompact = usePreferences((state) => state.setCompact);
  const [info, setInfo] = useState<AppInfo>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (!window.desktop)
        throw new Error("Open the desktop app to see its version.");
      setInfo(await window.desktop.getAppInfo());
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "App information is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          A workspace that works your way.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Find your comfortable amount of space.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="compact">Compact layout</FieldLabel>
                <FieldDescription>
                  Use less space around your workspace. Saved on this device.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="compact"
                checked={compact}
                onCheckedChange={setCompact}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>About Lanework</CardTitle>
          <CardDescription>Your desktop app, at a glance.</CardDescription>
        </CardHeader>
        <CardContent>
          <div aria-live="polite">
            {error ? (
              <p role="alert" className="text-sm text-muted-foreground">
                {error}
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <dt className="text-muted-foreground">Application</dt>
                <dd>{info?.name ?? "Loading…"}</dd>
                <dt className="text-muted-foreground">Version</dt>
                <dd>{info?.version ?? "—"}</dd>
                <dt className="text-muted-foreground">Platform</dt>
                <dd>{info?.platform ?? "—"}</dd>
              </dl>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Refresh app info
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
