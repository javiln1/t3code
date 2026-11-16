import { useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  GitForkIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { Children, type MouseEvent as ReactMouseEvent, type ReactNode, useState } from "react";
import { cn } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  foldSidebarFamilies,
  groupSidebarFamilies,
  isSidebarForkCalling,
  isSidebarOutsideClientThread,
  resolveSidebarFamilyRank,
  resolveSidebarFamilyStatus,
  resolveSidebarVisibleForks,
  type SidebarFamilyRank,
  splitSidebarLiveFamilies,
} from "../Sidebar.families.logic";
import {
  animateSidebarLayoutChanges,
  resolveThreadLastVisitedAt,
  SIDEBAR_GROKBOT_ITEM,
  sidebarForkGroupId,
  sidebarListItemId,
} from "../Sidebar.logic";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PINNED_EXPANDED_KEY = "t3code:sidebar:pinned-expanded";
const PINNED_HIDE_ALL_KEY = "t3code:sidebar:pinned-hide-all";
const GROKBOT_EXPANDED_KEY = "t3code:sidebar:grokbot-expanded";
const NO_FORKS: readonly SidebarThreadSummary[] = [];

const keyOf = (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** The status a parent row rolls up from its forks. */
export interface SidebarFamilyRowProps {
  /** The fork whose status the parent row shows, when a fork outranks the parent. */
  familyStatusFrom?: SidebarThreadSummary | null;
}

/**
 * Forks fold under their parent, outside-client threads (Grokbot) get their own section, and
 * Pinned folds to the families asking for the user. Boring mode's folders opt out.
 */
export function useSidebarFamilies(input: {
  readonly pinned: readonly SidebarThreadSummary[];
  readonly active: readonly SidebarThreadSummary[];
  readonly working: readonly SidebarThreadSummary[];
  readonly enabled: boolean;
  readonly routeRowThreadKey: string | null;
}) {
  const { routeRowThreadKey } = input;
  const [pinnedShelfExpanded, setPinnedExpanded] = useLocalStorage(
    PINNED_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [pinnedHideAll, setPinnedHideAll] = useLocalStorage(
    PINNED_HIDE_ALL_KEY,
    false,
    Schema.Boolean,
  );
  const [grokbotExpanded, setGrokbotExpanded] = useLocalStorage(
    GROKBOT_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [grokbotDoneExpanded, setGrokbotDoneExpanded] = useState(false);
  const [expandedParents, setExpandedParents] = useState<ReadonlySet<string>>(new Set());
  const lastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);

  const groups = input.enabled
    ? groupSidebarFamilies({
        pinned: input.pinned,
        active: input.active,
        working: input.working,
        keyOf,
        parentKeyOf: (thread) =>
          thread.lineage.parentThreadId === null
            ? null
            : keyOf({ environmentId: thread.environmentId, id: thread.lineage.parentThreadId }),
        isOutside: isSidebarOutsideClientThread,
      })
    : {
        pinned: input.pinned,
        active: input.active,
        working: input.working,
        outside: NO_FORKS,
        forksByParentKey: new Map<string, readonly SidebarThreadSummary[]>(),
      };
  const forksOf = (thread: SidebarThreadSummary) =>
    groups.forksByParentKey.get(keyOf(thread)) ?? NO_FORKS;
  const rankOf = (thread: SidebarThreadSummary): SidebarFamilyRank =>
    resolveSidebarFamilyRank({
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        lastVisitedAtById[keyOf(thread)],
      ),
    });
  const familyStatus = (thread: SidebarThreadSummary) =>
    resolveSidebarFamilyStatus(thread, forksOf(thread), rankOf);
  const familyRankOf = (thread: SidebarThreadSummary) => familyStatus(thread).rank;
  const isRoute = (thread: SidebarThreadSummary) => keyOf(thread) === routeRowThreadKey;
  const holdsRoute = (thread: SidebarThreadSummary) =>
    isRoute(thread) || forksOf(thread).some(isRoute);
  const visibleForks = (thread: SidebarThreadSummary) =>
    resolveSidebarVisibleForks(forksOf(thread), expandedParents.has(keyOf(thread)), isRoute);

  const toggleForks = (key: string) =>
    setExpandedParents((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const pinnedFold = pinnedShelfExpanded
    ? null
    : foldSidebarFamilies(groups.pinned, {
        rankOf: familyRankOf,
        holdsRoute,
        hideAll: pinnedHideAll,
      });

  const outside = splitSidebarLiveFamilies(groups.outside, familyRankOf);
  const finishedShown = grokbotDoneExpanded
    ? outside.finished
    : outside.finished.filter(holdsRoute);
  const grokbotShown = grokbotExpanded
    ? [...outside.live, ...finishedShown]
    : groups.outside.filter(holdsRoute);

  return {
    pinnedThreads: groups.pinned,
    activeThreads: groups.active,
    workingThreads: groups.working,
    visiblePinnedThreads: pinnedFold?.families ?? groups.pinned,
    pinnedShelfExpanded,
    togglePinnedShelf: () => setPinnedExpanded((value) => !value),
    pinnedFold:
      pinnedFold === null
        ? null
        : {
            shown: pinnedFold.shown,
            loud: pinnedFold.loud,
            hideAll: pinnedHideAll,
            onToggle: () => setPinnedHideAll((value) => !value),
          },
    grokbot: {
      count: outside.live.length,
      total: groups.outside.length,
      loud: groups.outside.some((thread) => familyRankOf(thread) === "needs-you"),
      expanded: grokbotExpanded,
      onToggle: () => setGrokbotExpanded((value) => !value),
      live: grokbotExpanded ? outside.live : groups.outside.filter(holdsRoute),
      finishedCount: outside.finished.length,
      finished: grokbotExpanded ? finishedShown : NO_FORKS,
      doneExpanded: grokbotDoneExpanded,
      onToggleDone: () => setGrokbotDoneExpanded((value) => !value),
    },
    holdsRoute,
    /** Folded Working keeps the open family and those whose fork asks for the user. */
    showsInFoldedWorking: (thread: SidebarThreadSummary) =>
      holdsRoute(thread) || isSidebarForkCalling(familyStatus(thread)),
    visibleForks,
    /** A list with each parent followed by its shown forks, for keyboard order and lookups. */
    withForks: (list: readonly SidebarThreadSummary[]) =>
      list.flatMap((thread) => [thread, ...visibleForks(thread)]),
    grokbotThreads: grokbotShown,
    rowProps: (thread: SidebarThreadSummary): SidebarFamilyRowProps => {
      if (forksOf(thread).length === 0) return {};
      const status = familyStatus(thread);
      return { familyStatusFrom: status.rank === "idle" ? null : status.from };
    },
    /** The line under a parent that has forks, or null when it has none. */
    forkLine: (thread: SidebarThreadSummary) => {
      const count = forksOf(thread).length;
      if (count === 0) return null;
      const key = keyOf(thread);
      return { count, expanded: expandedParents.has(key), onToggle: () => toggleForks(key) };
    },
  };
}

/** The thread a row reads its status from: the parent, or the fork outranking it. */
export function useSidebarFamilyStatusSource(from: SidebarThreadSummary | null | undefined) {
  const key = from == null ? null : keyOf(from);
  const localLastVisitedAt = useUiStateStore((store) =>
    key === null ? undefined : store.threadLastVisitedAtById[key],
  );
  return from == null
    ? null
    : {
        ...from,
        lastVisitedAt: resolveThreadLastVisitedAt(from.lastVisitedAt, localLastVisitedAt),
      };
}

/** A fork's branch, or the robot on a thread an outside client (Grokbot) launched. */
export function SidebarRowLineageIcon(props: { thread: SidebarThreadSummary }) {
  const { thread } = props;
  if (thread.lineage.relationshipToParent === "fork") {
    return (
      <GitForkIcon
        aria-label="Forked thread"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    );
  }
  if (!isSidebarOutsideClientThread(thread)) return null;
  return (
    <BotIcon
      aria-label={`Started by ${thread.source.launchedByClient}`}
      role="img"
      className="size-3 shrink-0 text-muted-foreground/65"
    />
  );
}

// Stable, since useSortable memoizes on it; a rider moves with drag transforms but is never picked up.
const RIDER_SORTABLE = { draggable: true } as const;

/** A listed block (a fork line, the Grokbot section) that moves with the rows while dragging. */
function useSidebarRiderSortable(id: string) {
  const { setNodeRef, transform, transition } = useSortable({
    id,
    disabled: RIDER_SORTABLE,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return {
    ref: setNodeRef,
    style: {
      transform: DndCSS.Translate.toString(transform),
      transition,
      visibility: transform?.scaleY === 0 ? ("hidden" as const) : undefined,
    },
  };
}

/** A quiet "3 forks" line under a parent card, with its shown forks indented on a rail below. */
export function SidebarForkGroup(props: {
  parentKey: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const noun = props.count === 1 ? "fork" : "forks";
  const stop = (event: ReactMouseEvent) => event.stopPropagation();
  const rider = useSidebarRiderSortable(sidebarForkGroupId(props.parentKey));
  return (
    <li {...rider} className="list-none pb-0.5" data-thread-selection-safe>
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? "Hide" : "Show"} ${props.count} ${noun}`}
        onClick={(event) => {
          stop(event);
          props.onToggle();
        }}
        onDoubleClick={stop}
        // ms-1.5 plus px-1 lines the chevron up with the card's text at --sidebar-row-content-inset.
        className="ms-1.5 flex h-4.5 cursor-pointer items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground/60 tabular-nums outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", props.expanded && "rotate-180")}
        />
        {props.count} {noun}
      </button>
      {Children.count(props.children) > 0 ? (
        <ul
          role="presentation"
          aria-label="Forks"
          className="ms-3 flex flex-col gap-px border-s border-sidebar-border ps-1"
        >
          {props.children}
        </ul>
      ) : null}
    </li>
  );
}

function NeedsYouDot() {
  return (
    <span
      role="img"
      aria-label="Something here needs you"
      className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
    />
  );
}

/**
 * The trailing count of a folded header. The eye sits over the reserved slot at its end; the
 * header button owns the rest of the line, so the eye cannot nest inside it.
 */
export function SidebarFoldAccessory(props: {
  count: number;
  shown: number | null;
  dot: boolean;
  reserveEye: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 font-normal tabular-nums">
      {props.dot ? <NeedsYouDot /> : null}
      <span>
        {props.shown === null ? null : `${props.shown} of `}
        {props.count}
      </span>
      {props.reserveEye ? <span aria-hidden className="size-4" /> : null}
    </span>
  );
}

/** Hides even the families asking for the user; the crossed-out eye stays while it does. */
export function SidebarFoldEye(props: { hideAll: boolean; onToggle: () => void }) {
  const label = props.hideAll ? "Show threads that need you" : "Hide every thread";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={props.hideAll}
            onClick={props.onToggle}
            className={cn(
              // Over the accessory's reserved slot: px-2, the size-3 chevron and gap-2 end at 28px.
              "absolute top-1/2 right-7 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              !props.hideAll && "opacity-0 group-hover/sidebar-fold:opacity-100",
            )}
          />
        }
      >
        {props.hideAll ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Families an outside client launched. Folded, it keeps only the open thread's family. */
export function SidebarGrokbotSection(props: {
  grokbot: ReturnType<typeof useSidebarFamilies>["grokbot"];
  renderFamily: (thread: SidebarThreadSummary) => ReactNode[];
}) {
  const { grokbot } = props;
  const rider = useSidebarRiderSortable(sidebarListItemId(SIDEBAR_GROKBOT_ITEM));
  if (grokbot.total === 0) return null;
  return (
    <li {...rider} className="list-none">
      <ul role="presentation" className="flex flex-col gap-px">
        <li className="relative mx-0.5 h-8 list-none" data-thread-selection-safe>
          <CollapsibleSectionHeader
            onClick={grokbot.onToggle}
            expanded={grokbot.expanded}
            data-testid="sidebar-grokbot-shelf-toggle"
            accessory={
              <SidebarFoldAccessory
                count={grokbot.count}
                shown={null}
                dot={grokbot.loud}
                reserveEye={false}
              />
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <BotIcon aria-hidden className="size-3.5 shrink-0" />
              Grokbot
            </span>
          </CollapsibleSectionHeader>
        </li>
        {grokbot.live.flatMap(props.renderFamily)}
        {grokbot.expanded && grokbot.finishedCount > 0 ? (
          <li className="list-none">
            <button
              type="button"
              aria-expanded={grokbot.doneExpanded}
              onClick={grokbot.onToggleDone}
              data-testid="sidebar-grokbot-done-toggle"
              className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {grokbot.finishedCount} done
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3 transition-transform", grokbot.doneExpanded && "rotate-90")}
              />
            </button>
          </li>
        ) : null}
        {grokbot.finished.flatMap(props.renderFamily)}
      </ul>
    </li>
  );
}
