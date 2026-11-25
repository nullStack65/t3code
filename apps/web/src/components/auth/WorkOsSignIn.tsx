import { useState } from "react";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

export function WorkOsSignIn({ signedIn = false }: { signedIn?: boolean }) {
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = signedIn ? "Sign out of Google session" : "Sign in with Google";
  const desktop = window.desktopBridge;

  if (!desktop) {
    const path = signedIn ? "/api/auth/workos/logout" : "/api/auth/workos/start";
    const url = new URL(resolvePrimaryEnvironmentHttpUrl(path));
    if (url.origin !== window.location.origin || url.protocol !== "https:") return null;
    return (
      <form action={url.href} method="post">
        <Button size="sm" type="submit">
          {label}
        </Button>
      </form>
    );
  }

  const run = desktop.workOsSignIn;
  if (!run) return null;
  const act = async (action: "start" | "finish" | "logout") => {
    setBusy(true);
    setError("");
    try {
      await run(action);
      if (action === "start") setStarted(true);
      else window.location.assign(signedIn ? "/pair" : "/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Google sign-in could not be completed.");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act(signedIn ? "logout" : "start")}>
          {started ? "Restart Google sign-in" : label}
        </Button>
        {started && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("finish")}>
            Finish sign-in
          </Button>
        )}
      </div>
      {started && (
        <p className="text-xs text-muted-foreground">
          Sign in in your system browser, then return here to finish.
        </p>
      )}
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
