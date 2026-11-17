import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  hasUnseenCompletion,
  resolveSidebarDropTarget,
  resolveSidebarThreadStatus,
  type SidebarSection,
} from "./Sidebar.logic";

/** A family's loudest state, most urgent first. An unread Done outranks work still going. */
const SIDEBAR_FAMILY_RANKS = ["needs-you", "done", "running", "idle"] as const;
export type SidebarFamilyRank = (typeof SIDEBAR_FAMILY_RANKS)[number];

type FamilyStatusInput = Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof resolveSidebarThreadStatus>[0];

export function resolveSidebarFamilyRank(thread: FamilyStatusInput): SidebarFamilyRank {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return "needs-you";
  // "waiting" is a running turn blocked on another thread, so its work is still going.
  if (status === "preparing" || status === "working" || status === "waiting") return "running";
  return status === "ready" && hasUnseenCompletion(thread) ? "done" : "idle";
}

/**
 * The parent row carries its family's loudest rank. `from` names the fork it came from, so the
 * row can say so; a tie goes to the parent.
 */
export function resolveSidebarFamilyStatus<T>(
  parent: T,
  forks: readonly T[],
  rankOf: (thread: T) => SidebarFamilyRank,
): { readonly rank: SidebarFamilyRank; readonly from: T | null } {
  let rank = rankOf(parent);
  let from: T | null = null;
  for (const fork of forks) {
    const forkRank = rankOf(fork);
    if (SIDEBAR_FAMILY_RANKS.indexOf(forkRank) < SIDEBAR_FAMILY_RANKS.indexOf(rank)) {
      rank = forkRank;
      from = fork;
    }
  }
  return { rank, from };
}

/** A fork asking for the user, or with an unread Done, keeps its family in a folded section. */
export function isSidebarForkCalling(status: {
  readonly rank: SidebarFamilyRank;
  readonly from: unknown;
}): boolean {
  return status.from !== null && (status.rank === "needs-you" || status.rank === "done");
}

interface FamilyThread {
  readonly lineage: { readonly parentThreadId: string | null };
  readonly linkOrigin?: unknown;
  readonly source?: { readonly launchedByClient?: string | undefined } | undefined;
}

/**
 * A top-level thread an outside MCP client launched, such as Grokbot. Only the server can tell
 * that client from an agent inside T3 (both launch as `mcp`/`agent`), so unstamped threads never
 * count.
 */
export function isSidebarOutsideClientThread(thread: FamilyThread): boolean {
  return (
    thread.lineage.parentThreadId === null &&
    thread.linkOrigin == null &&
    (thread.source?.launchedByClient ?? "") !== ""
  );
}

export interface SidebarFamilyGroups<T> {
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly working: readonly T[];
  /** Top-level outside-client threads from any of the sections above; they beat Pinned. */
  readonly outside: readonly T[];
  readonly forksByParentKey: ReadonlyMap<string, readonly T[]>;
}

/**
 * Folds listed forks under the nearest ancestor that is also listed in a card section, at any
 * depth. A fork whose parent is not listed there (settled, snoozed, filtered out, gone) keeps
 * its own row.
 */
export function groupSidebarFamilies<T>(input: {
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly working: readonly T[];
  readonly keyOf: (thread: T) => string;
  readonly parentKeyOf: (thread: T) => string | null;
  readonly isOutside: (thread: T) => boolean;
}): SidebarFamilyGroups<T> {
  const { keyOf, parentKeyOf } = input;
  const byKey = new Map<string, T>();
  for (const list of [input.pinned, input.active, input.working]) {
    for (const thread of list) byKey.set(keyOf(thread), thread);
  }
  // A broken chain (a cycle) leaves the thread as its own row rather than hiding it.
  const rootKeyOf = (thread: T): string => {
    let key = keyOf(thread);
    const seen = new Set([key]);
    for (let parent = parentKeyOf(thread); parent !== null && byKey.has(parent);) {
      if (seen.has(parent)) return keyOf(thread);
      seen.add(parent);
      key = parent;
      parent = parentKeyOf(byKey.get(key)!);
    }
    return key;
  };
  const forksByParentKey = new Map<string, T[]>();
  const isTop = (thread: T) => {
    const root = rootKeyOf(thread);
    if (root === keyOf(thread)) return true;
    const forks = forksByParentKey.get(root);
    if (forks === undefined) forksByParentKey.set(root, [thread]);
    else forks.push(thread);
    return false;
  };
  const tops = {
    pinned: input.pinned.filter(isTop),
    active: input.active.filter(isTop),
    working: input.working.filter(isTop),
  };
  const outside = [...tops.active, ...tops.working, ...tops.pinned].filter(input.isOutside);
  if (outside.length === 0) return { ...tops, outside, forksByParentKey };
  const inside = (thread: T) => !input.isOutside(thread);
  return {
    pinned: tops.pinned.filter(inside),
    active: tops.active.filter(inside),
    working: tops.working.filter(inside),
    outside,
    forksByParentKey,
  };
}

/**
 * A family with forks sits by its loudest rank, not its parent's: one with nothing for the user
 * but work still going moves to Working, and a fork asking or done brings it back to the top.
 */
export function placeSidebarFamilies<T>(
  groups: { readonly active: readonly T[]; readonly working: readonly T[] },
  input: {
    readonly hasForks: (thread: T) => boolean;
    readonly rankOf: (family: T) => SidebarFamilyRank;
  },
): { readonly active: readonly T[]; readonly working: readonly T[] } {
  const loud = (thread: T) => {
    const rank = input.rankOf(thread);
    return rank === "needs-you" || rank === "done";
  };
  const toWorking = groups.active.filter(
    (thread) => input.hasForks(thread) && input.rankOf(thread) === "running",
  );
  const toActive = groups.working.filter((thread) => input.hasForks(thread) && loud(thread));
  if (toWorking.length === 0 && toActive.length === 0) return groups;
  return {
    active: [...toActive, ...groups.active.filter((thread) => !toWorking.includes(thread))],
    working: [...toWorking, ...groups.working.filter((thread) => !toActive.includes(thread))],
  };
}

/**
 * A folded section keeps the families asking for the user, waiting ones first, then the one
 * holding the open thread. `hideAll` (the eye) keeps only that one.
 */
export function foldSidebarFamilies<T>(
  families: readonly T[],
  input: {
    readonly rankOf: (family: T) => SidebarFamilyRank;
    readonly holdsRoute: (family: T) => boolean;
    readonly hideAll: boolean;
  },
): { readonly families: readonly T[]; readonly shown: number; readonly loud: boolean } {
  const waiting: T[] = [];
  const done: T[] = [];
  let route: T | null = null;
  for (const family of families) {
    const rank = input.rankOf(family);
    if (input.holdsRoute(family) && (input.hideAll || (rank !== "needs-you" && rank !== "done")))
      route = family;
    else if (rank === "needs-you") waiting.push(family);
    else if (rank === "done") done.push(family);
  }
  const loud = [...waiting, ...done];
  const shown = input.hideAll ? [] : loud;
  return {
    families: route === null ? shown : [...shown, route],
    shown: shown.length,
    loud: loud.length > 0,
  };
}

/** Grokbot keeps families with something on (asking, running, or unread Done) above its done fold. */
export function splitSidebarLiveFamilies<T>(
  families: readonly T[],
  rankOf: (family: T) => SidebarFamilyRank,
): { readonly live: readonly T[]; readonly finished: readonly T[] } {
  const live: T[] = [];
  const finished: T[] = [];
  for (const family of families) (rankOf(family) === "idle" ? finished : live).push(family);
  return { live, finished };
}

/** A folded Pinned section hides its order, so a drop there can only pin to the top. */
export function foldSidebarPinnedDropTarget(
  target: ReturnType<typeof resolveSidebarDropTarget>,
  input: {
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly pinnedOrder: readonly string[];
  },
): ReturnType<typeof resolveSidebarDropTarget> {
  if (target?.section !== "pinned") return target;
  if (input.activeSection === "pinned") return null;
  return {
    ...target,
    pinnedOrder: [input.activeKey, ...input.pinnedOrder.filter((key) => key !== input.activeKey)],
  };
}

/** Forks stay tucked until the pill opens them; the open fork still shows under its parent. */
export function resolveSidebarVisibleForks<T>(
  forks: readonly T[],
  expanded: boolean,
  isRoute: (fork: T) => boolean,
): readonly T[] {
  return expanded ? forks : forks.filter(isRoute);
}

/**
 * A Lineage fork row's status where it differs from its last run's: "Needs you" on the same
 * approvals and questions as its sidebar row, and "Waiting" while it waits on a child thread or
 * on background work, as the sidebar shows. Otherwise the run's own status stands.
 */
export function lineageForkStatus(
  thread:
    | Pick<
        OrchestrationV2ThreadShell,
        | "pendingRuntimeRequest"
        | "blockedOnThreadWait"
        | "pendingBackgroundTasks"
        | "activityRunStatus"
        | "status"
      >
    | null
    | undefined,
): "needs_you" | "waiting" | undefined {
  if (thread == null) return undefined;
  const kind = thread.pendingRuntimeRequest?.kind;
  if (kind !== undefined && kind !== "auth_refresh") return "needs_you";
  const runStatus = thread.activityRunStatus ?? thread.status;
  if (runStatus === "failed") return undefined;
  if (thread.blockedOnThreadWait === true && runStatus === "running") return "waiting";
  return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) ? "waiting" : undefined;
}
