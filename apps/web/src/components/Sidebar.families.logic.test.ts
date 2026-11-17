import { describe, expect, it } from "vite-plus/test";
import {
  foldSidebarFamilies,
  foldSidebarPinnedDropTarget,
  groupSidebarFamilies,
  isSidebarForkCalling,
  isSidebarOutsideClientThread,
  placeSidebarFamilies,
  resolveSidebarFamilyRank,
  resolveSidebarFamilyStatus,
  resolveSidebarVisibleForks,
  type SidebarFamilyRank,
  splitSidebarLiveFamilies,
} from "./Sidebar.families.logic";

interface Row {
  readonly key: string;
  readonly parent?: string;
  readonly outside?: boolean;
}

const group = (input: {
  pinned?: readonly Row[];
  active?: readonly Row[];
  working?: readonly Row[];
}) => {
  const groups = groupSidebarFamilies({
    pinned: input.pinned ?? [],
    active: input.active ?? [],
    working: input.working ?? [],
    keyOf: (row) => row.key,
    parentKeyOf: (row) => row.parent ?? null,
    isOutside: (row) => row.outside === true,
  });
  const keys = (rows: readonly Row[]) => rows.map((row) => row.key);
  return {
    pinned: keys(groups.pinned),
    active: keys(groups.active),
    working: keys(groups.working),
    outside: keys(groups.outside),
    forks: Object.fromEntries([...groups.forksByParentKey].map(([key, rows]) => [key, keys(rows)])),
  };
};

describe("groupSidebarFamilies", () => {
  it("folds forks under the parent's row, whatever section either sits in", () => {
    expect(
      group({
        pinned: [{ key: "hq" }],
        active: [{ key: "f1", parent: "hq" }, { key: "solo" }, { key: "f2", parent: "hq" }],
        working: [{ key: "f3", parent: "solo" }],
      }),
    ).toEqual({
      pinned: ["hq"],
      active: ["solo"],
      working: [],
      outside: [],
      forks: { hq: ["f1", "f2"], solo: ["f3"] },
    });
  });

  it("folds a fork of a fork under the top listed ancestor", () => {
    expect(
      group({ active: [{ key: "hq" }, { key: "f1", parent: "hq" }, { key: "f2", parent: "f1" }] })
        .forks,
    ).toEqual({ hq: ["f1", "f2"] });
  });

  it("keeps a fork whose parent is not listed as its own row, and survives a cycle", () => {
    expect(
      group({
        active: [
          { key: "orphan", parent: "settled-hq" },
          { key: "a", parent: "b" },
          { key: "b", parent: "a" },
        ],
      }),
    ).toMatchObject({ active: ["orphan", "a", "b"], forks: {} });
  });

  it("moves outside-client families out of every section, and beats Pinned", () => {
    expect(
      group({
        pinned: [{ key: "grok-pinned", outside: true }, { key: "hq" }],
        active: [
          { key: "grok", outside: true },
          { key: "fork", parent: "grok" },
        ],
      }),
    ).toEqual({
      pinned: ["hq"],
      active: [],
      working: [],
      outside: ["grok", "grok-pinned"],
      forks: { grok: ["fork"] },
    });
  });
});

describe("resolveSidebarVisibleForks", () => {
  it.each([
    ["collapsed: none, even when they need you", false, null, []],
    ["collapsed: only the open fork", false, "f2", ["f2"]],
    ["expanded: all of them", true, null, ["f1", "f2"]],
  ] as const)("shows %s", (_, expanded, route, shown) => {
    expect(resolveSidebarVisibleForks(["f1", "f2"], expanded, (fork) => fork === route)).toEqual(
      shown,
    );
  });
});

describe("resolveSidebarFamilyStatus", () => {
  const ranks: Record<string, SidebarFamilyRank> = {};
  const status = (parent: SidebarFamilyRank, ...forks: SidebarFamilyRank[]) => {
    ranks.parent = parent;
    forks.forEach((rank, index) => (ranks[`fork${index}`] = rank));
    const result = resolveSidebarFamilyStatus(
      "parent",
      forks.map((_, index) => `fork${index}`),
      (key) => ranks[key]!,
    );
    return [result.rank, result.from];
  };

  it.each([
    ["the parent alone", ["idle"], ["idle", null]],
    [
      "a fork that needs you, with the fork note",
      ["idle", "done", "needs-you"],
      ["needs-you", "fork1"],
    ],
    ["a fork's unread Done over the parent's run", ["running", "done"], ["done", "fork0"]],
    [
      "the parent's own status when it ties a fork",
      ["needs-you", "needs-you"],
      ["needs-you", null],
    ],
    [
      "the parent's own status when it outranks the forks",
      ["done", "running", "idle"],
      ["done", null],
    ],
  ] as const)("shows %s", (_, [parent, ...forks], expected) => {
    expect(status(parent, ...forks)).toEqual(expected);
  });
});

describe("isSidebarForkCalling", () => {
  it.each([
    [{ rank: "needs-you", from: "fork" }, true],
    [{ rank: "done", from: "fork" }, true],
    [{ rank: "running", from: "fork" }, false],
    [{ rank: "needs-you", from: null }, false],
  ] as const)("keeps %o folded open: %s", (status, expected) => {
    expect(isSidebarForkCalling(status)).toBe(expected);
  });
});

describe("placeSidebarFamilies", () => {
  const ranks: Record<string, SidebarFamilyRank> = {
    hqWaiting: "running",
    hqDone: "done",
    hqAsking: "needs-you",
    hqIdle: "idle",
    solo: "running",
    runner: "running",
  };
  const place = (active: readonly string[], working: readonly string[]) =>
    placeSidebarFamilies(
      { active, working },
      { hasForks: (key) => key.startsWith("hq"), rankOf: (key) => ranks[key]! },
    );

  it("moves a family with only work going to Working, and a loud one to the top", () => {
    expect(place(["hqIdle", "hqWaiting", "solo"], ["runner", "hqDone", "hqAsking"])).toEqual({
      active: ["hqDone", "hqAsking", "hqIdle", "solo"],
      working: ["hqWaiting", "runner"],
    });
  });

  it("leaves threads without forks where their own status put them", () => {
    const groups = { active: ["solo"], working: ["runner"] };
    expect(
      placeSidebarFamilies(groups, { hasForks: () => false, rankOf: (key) => ranks[key]! }),
    ).toBe(groups);
  });
});

describe("resolveSidebarFamilyRank", () => {
  const idle = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: null,
    latestRun: {
      runId: "run-1" as never,
      status: "completed" as const,
      assistantMessageId: null,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
    },
    lastVisitedAt: "2026-03-09T10:06:00.000Z",
  };

  it.each([
    ["an approval", { hasPendingApprovals: true }, "needs-you"],
    ["a question", { hasPendingUserInput: true }, "needs-you"],
    ["a run", { runtime: { status: "running" } }, "running"],
    [
      "a run waiting on a child",
      { runtime: { status: "running" }, blockedOnThreadWait: true },
      "running",
    ],
    ["an unseen finish", { lastVisitedAt: "2026-03-09T10:04:00.000Z" }, "done"],
    ["a seen finish", {}, "idle"],
  ] as const)("ranks %s as %s", (_, overrides, rank) => {
    expect(resolveSidebarFamilyRank({ ...idle, ...overrides } as typeof idle)).toBe(rank);
  });
});

describe("isSidebarOutsideClientThread", () => {
  const top = { lineage: { parentThreadId: null }, linkOrigin: null };
  it.each([
    ["a stamped top-level launch", { ...top, source: { launchedByClient: "Grokbot" } }, true],
    ["an unstamped MCP launch (from inside T3)", { ...top, source: {} }, false],
    [
      "a fork of a stamped thread",
      { ...top, lineage: { parentThreadId: "hq" }, source: { launchedByClient: "Grokbot" } },
      false,
    ],
    [
      "a linked environment's launch",
      { ...top, linkOrigin: { sessionId: "s" }, source: { launchedByClient: "Grokbot" } },
      false,
    ],
  ] as const)("%s → %s", (_, thread, expected) => {
    expect(isSidebarOutsideClientThread(thread)).toBe(expected);
  });
});

describe("foldSidebarFamilies", () => {
  const ranks: Record<string, SidebarFamilyRank> = {
    w1: "needs-you",
    w2: "needs-you",
    d1: "done",
    r1: "running",
    q1: "idle",
    route: "idle",
  };
  const fold = (families: readonly string[], route: string | null, hideAll = false) =>
    foldSidebarFamilies(families, {
      rankOf: (key) => ranks[key]!,
      holdsRoute: (key) => key === route,
      hideAll,
    });

  it("keeps families asking for you, waiting first, then the open thread's family", () => {
    expect(fold(["q1", "d1", "w1", "route", "r1", "w2"], "route")).toEqual({
      families: ["w1", "w2", "d1", "route"],
      shown: 3,
      loud: true,
    });
    expect(fold(["q1", "d1", "w1"], "w1").families).toEqual(["w1", "d1"]);
    expect(fold(["q1", "r1"], null)).toEqual({ families: [], shown: 0, loud: false });
  });

  it("hides everything but the open thread's family behind the eye, and still reports loud", () => {
    expect(fold(["w1", "d1", "route"], "route", true)).toEqual({
      families: ["route"],
      shown: 0,
      loud: true,
    });
    expect(fold(["w1", "q1"], "w1", true).families).toEqual(["w1"]);
  });
});

describe("splitSidebarLiveFamilies", () => {
  it("puts read, finished families behind the done fold and keeps unread Done live", () => {
    const ranks: Record<string, SidebarFamilyRank> = {
      a: "needs-you",
      b: "idle",
      c: "running",
      d: "done",
      e: "idle",
    };
    expect(splitSidebarLiveFamilies(["a", "b", "c", "d", "e"], (key) => ranks[key]!)).toEqual({
      live: ["a", "c", "d"],
      finished: ["b", "e"],
    });
  });
});

describe("foldSidebarPinnedDropTarget", () => {
  it("pins a drop onto folded Pinned to the top, and ignores pinned rows dropped there", () => {
    const target = { section: "pinned", pinnedOrder: ["p2", "x"], activeOrder: [] } as const;
    const pinnedOrder = ["p1", "p2", "p3"];
    expect(
      foldSidebarPinnedDropTarget(target, {
        activeKey: "a1",
        activeSection: "active",
        pinnedOrder,
      }),
    ).toEqual({ ...target, pinnedOrder: ["a1", "p1", "p2", "p3"] });
    expect(
      foldSidebarPinnedDropTarget(target, {
        activeKey: "p2",
        activeSection: "pinned",
        pinnedOrder,
      }),
    ).toBeNull();
    const activeTarget = { section: "active", pinnedOrder: [], activeOrder: ["p2"] } as const;
    expect(
      foldSidebarPinnedDropTarget(activeTarget, {
        activeKey: "p2",
        activeSection: "pinned",
        pinnedOrder,
      }),
    ).toBe(activeTarget);
  });
});
