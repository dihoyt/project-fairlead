import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { FirstRunStep } from "../ui/contracts";
import { useSession } from "../ui/session";

interface Check {
  key: string;
  path: Promise<string | null>;
  used: boolean;
}

// One check per page load, shared by every mount: StrictMode (and any
// remount) cancels the first effect while its checks are in flight, so the
// result has to outlive it rather than be owned by it.
let current: Check | null = null;

// sessionStorage makes the redirect once per browser session; it is marked
// before the checks run, so a reload mid-check doesn't redirect twice.
function alreadyDone(key: string): boolean {
  try {
    if (sessionStorage.getItem(key)) return true;
    sessionStorage.setItem(key, "1");
  } catch {
    // Storage unavailable: once per page load instead.
  }
  return false;
}

async function firstPending(steps: FirstRunStep[]): Promise<string | null> {
  for (const step of steps) {
    if (await step.isPending().catch(() => false)) return step.path;
  }
  return null;
}

export function useFirstRun(steps: FirstRunStep[]): void {
  const { me } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!me.admin || steps.length === 0) return;
    const key = `first-run-checked:${me.id}`;
    if (current?.key !== key) {
      if (alreadyDone(key)) return;
      current = { key, path: firstPending(steps), used: false };
    }
    const check = current;
    let cancelled = false;
    void check.path.then((path) => {
      if (cancelled || check.used || path === null) return;
      check.used = true;
      navigate(path);
    });
    return () => {
      cancelled = true;
    };
  }, [me.admin, me.id, steps, navigate]);
}
