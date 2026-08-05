import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  collectCompletedResponses,
  requestResponseNotificationPermission,
  showResponseNotification,
  snapshotObservedTurns,
} from "./responseNotifications";

const NOW = Date.parse("2026-08-03T10:00:00.000Z");
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");

function makeThread(
  state: "running" | "interrupted" | "completed" | "error",
  overrides: Partial<EnvironmentThreadShell["latestTurn"]> = {},
): EnvironmentThreadShell {
  return {
    environmentId,
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Shipping notifications",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId,
      state,
      requestedAt: "2026-08-03T09:59:00.000Z",
      startedAt: "2026-08-03T09:59:01.000Z",
      completedAt: state === "completed" ? "2026-08-03T09:59:59.000Z" : null,
      assistantMessageId: null,
      ...overrides,
    },
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: "2026-08-03T09:59:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectCompletedResponses", () => {
  it("detects a recently completed response after observing the same running turn", () => {
    const previous = snapshotObservedTurns([makeThread("running")]);

    expect(
      collectCompletedResponses({ previous, threads: [makeThread("completed")], now: NOW }),
    ).toEqual([
      {
        ref: { environmentId, threadId },
        title: "Shipping notifications",
        turnId,
      },
    ]);
  });

  it("ignores a different turn, a stale completion, and non-completed states", () => {
    const previous = snapshotObservedTurns([makeThread("running")]);

    expect(
      collectCompletedResponses({
        previous,
        threads: [makeThread("completed", { turnId: TurnId.make("turn-2") })],
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      collectCompletedResponses({
        previous,
        threads: [
          makeThread("completed", { completedAt: "2026-08-03T09:55:00.000Z" }),
          makeThread("error"),
        ],
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("requestResponseNotificationPermission", () => {
  it("requests browser permission when the decision is still pending", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("window", { Notification: { permission: "default", requestPermission } });

    await expect(requestResponseNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledOnce();
  });
});

describe("showResponseNotification", () => {
  it("shows a native notification while unfocused and opens its thread on click", () => {
    const close = vi.fn();
    let click: (() => void) | undefined;
    const Notification = vi.fn(function (this: unknown) {
      return {
        addEventListener: (_event: string, handler: () => void) => {
          click = handler;
        },
        close,
      };
    });
    Object.assign(Notification, { permission: "granted" });
    const focus = vi.fn();
    const onOpen = vi.fn();
    vi.stubGlobal("window", { Notification, focus });
    vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });

    const completion = collectCompletedResponses({
      previous: snapshotObservedTurns([makeThread("running")]),
      threads: [makeThread("completed")],
      now: NOW,
    })[0];

    expect(completion).toBeDefined();
    expect(showResponseNotification({ completion: completion!, onOpen })).toBe(true);
    expect(Notification).toHaveBeenCalledWith("Response ready", {
      body: "Shipping notifications has finished.",
      tag: `t3code:response:${environmentId}:${threadId}`,
    });

    click?.();
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({ environmentId, threadId });
  });

  it("stays quiet while T3 Code is visible and focused", () => {
    const Notification = Object.assign(vi.fn(), { permission: "granted" });
    vi.stubGlobal("window", { Notification });
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });

    expect(
      showResponseNotification({
        completion: { ref: { environmentId, threadId }, title: "Thread", turnId },
        onOpen: vi.fn(),
      }),
    ).toBe(false);
    expect(Notification).not.toHaveBeenCalled();
  });
});
