import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";

const MAX_COMPLETION_AGE_MS = 2 * 60_000;

export type ResponseNotificationPermission = "granted" | "denied" | "unsupported";

export async function requestResponseNotificationPermission(): Promise<ResponseNotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  if (window.Notification.permission === "granted") {
    return "granted";
  }
  if (window.Notification.permission === "denied") {
    return "denied";
  }

  try {
    const permission = await window.Notification.requestPermission();
    return permission === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export interface ObservedTurn {
  readonly turnId: TurnId;
  readonly state: "running" | "interrupted" | "completed" | "error";
}

export interface CompletedResponse {
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly turnId: TurnId;
}

export function snapshotObservedTurns(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, ObservedTurn> {
  return new Map(
    threads.flatMap((thread) => {
      const turn = thread.latestTurn;
      return turn === null
        ? []
        : [
            [
              `${thread.environmentId}:${thread.id}`,
              { turnId: turn.turnId, state: turn.state },
            ] as const,
          ];
    }),
  );
}

export function collectCompletedResponses(input: {
  readonly previous: ReadonlyMap<string, ObservedTurn>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now?: number;
}): ReadonlyArray<CompletedResponse> {
  const now = input.now ?? Date.now();
  return input.threads.flatMap((thread) => {
    const current = thread.latestTurn;
    if (current?.state !== "completed" || current.completedAt === null) {
      return [];
    }

    const previous = input.previous.get(`${thread.environmentId}:${thread.id}`);
    const completedAt = Date.parse(current.completedAt);
    if (
      previous?.turnId !== current.turnId ||
      previous.state !== "running" ||
      !Number.isFinite(completedAt) ||
      now - completedAt > MAX_COMPLETION_AGE_MS
    ) {
      return [];
    }

    return [
      {
        ref: { environmentId: thread.environmentId, threadId: thread.id },
        title: thread.title,
        turnId: current.turnId,
      },
    ];
  });
}

export function showResponseNotification(input: {
  readonly completion: CompletedResponse;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}): boolean {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    window.Notification.permission !== "granted" ||
    (document.visibilityState === "visible" && document.hasFocus())
  ) {
    return false;
  }

  let notification: Notification;
  try {
    notification = new window.Notification("Response ready", {
      body: `${input.completion.title} has finished.`,
      tag: `t3code:response:${input.completion.ref.environmentId}:${input.completion.ref.threadId}`,
    });
  } catch {
    return false;
  }

  notification.addEventListener(
    "click",
    () => {
      notification.close();
      window.focus();
      input.onOpen(input.completion.ref);
    },
    { once: true },
  );
  return true;
}
