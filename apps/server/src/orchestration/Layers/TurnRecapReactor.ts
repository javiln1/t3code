/**
 * TurnRecapReactor – generates a one-line recap of each finished agent turn.
 *
 * Hooks the provider-neutral `turn.completed` runtime event, so a recap is
 * produced the same way no matter which agent ran the turn. The recap itself
 * comes from the configured text-generation model (the same cheap model that
 * writes thread titles and commit messages), never from the agent that did the
 * work, and lands as a `turn.recap` thread activity so every attached client
 * renders it from the projection instead of deriving it locally.
 *
 * @module TurnRecapReactor
 */
import {
  CommandId,
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TurnRecapReactor, type TurnRecapReactorShape } from "../Services/TurnRecapReactor.ts";
import { forkParked } from "../../serverActivation.ts";

/** Activity kind carrying a generated recap. Mirrored by the web client. */
export const TURN_RECAP_ACTIVITY_KIND = "turn.recap";

/**
 * A turn that neither ran a tool nor said much is its own best summary — a
 * recap under it would be noise, so short toolless turns are skipped.
 */
const MIN_RECAPPABLE_ASSISTANT_CHARS = 600;

/** Bounds on the transcript handed to the recap model. */
const MAX_TRANSCRIPT_ACTIVITIES = 60;
const MAX_ACTIVITY_SUMMARY_CHARS = 200;
const MAX_ASSISTANT_CHARS = 6_000;
const MAX_USER_CHARS = 2_000;

/**
 * Activity kinds that describe bookkeeping rather than work. They would pad the
 * transcript without telling the model anything about what happened.
 */
const TRANSCRIPT_ACTIVITY_KIND_DENYLIST = new Set([
  TURN_RECAP_ACTIVITY_KIND,
  "checkpoint.captured",
  "context-window.updated",
  "tool.progress",
  "tool.started",
  "task.updated",
]);

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

function tailTruncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

interface TurnTranscript {
  readonly text: string;
  /** Whether the turn is substantial enough to be worth recapping. */
  readonly worthRecapping: boolean;
}

/**
 * Flattens one turn into the text the recap model sees: the request that
 * started it, the work it did, and what it said back.
 *
 * The prompting user message is not tagged with the turn id, so it is found by
 * walking back from the turn's first message — the last user message before the
 * turn started.
 */
export function buildTurnTranscript(input: {
  readonly messages: OrchestrationThread["messages"];
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnId: TurnId;
}): TurnTranscript {
  const turnMessageIndex = input.messages.findIndex((message) => message.turnId === input.turnId);
  const priorUserMessage =
    turnMessageIndex === -1
      ? input.messages.findLast((message) => message.role === "user")
      : input.messages.slice(0, turnMessageIndex).findLast((message) => message.role === "user");

  const assistantText = input.messages
    .filter(
      (message) =>
        message.turnId === input.turnId &&
        message.role === "assistant" &&
        message.text.trim().length > 0,
    )
    .map((message) => message.text.trim())
    .join("\n\n");

  const workLines = input.activities
    .filter(
      (activity) =>
        activity.turnId === input.turnId &&
        !TRANSCRIPT_ACTIVITY_KIND_DENYLIST.has(activity.kind) &&
        activity.summary.trim().length > 0,
    )
    .slice(-MAX_TRANSCRIPT_ACTIVITIES)
    .map((activity) => `- ${truncate(activity.summary, MAX_ACTIVITY_SUMMARY_CHARS)}`);

  const sections: Array<string> = [];
  if (priorUserMessage && priorUserMessage.text.trim().length > 0) {
    sections.push(`What was asked:\n${tailTruncate(priorUserMessage.text, MAX_USER_CHARS)}`);
  }
  if (workLines.length > 0) {
    sections.push(`What the agent did:\n${workLines.join("\n")}`);
  }
  if (assistantText.length > 0) {
    sections.push(
      `What the agent reported back:\n${tailTruncate(assistantText, MAX_ASSISTANT_CHARS)}`,
    );
  }

  return {
    text: sections.join("\n\n"),
    worthRecapping:
      sections.length > 0 &&
      (workLines.length > 0 || assistantText.length >= MIN_RECAPPABLE_ASSISTANT_CHARS),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const appendRecapFromTurnCompletion = Effect.fn("appendRecapFromTurnCompletion")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    // A turn the user cut short has no outcome worth narrating back to them.
    if (event.payload.state === "cancelled" || event.payload.state === "interrupted") {
      return;
    }

    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const { enableTurnRecaps } = yield* serverSettingsService.getSettings;
    if (!enableTurnRecaps) {
      return;
    }

    const thread = yield* resolveThreadDetail(event.threadId);
    if (!thread) {
      return;
    }

    // Runtime completion can be observed more than once for a turn (retries,
    // reconnects); one recap per turn is enough.
    if (
      thread.activities.some(
        (activity) => activity.kind === TURN_RECAP_ACTIVITY_KIND && activity.turnId === turnId,
      )
    ) {
      return;
    }

    const transcript = buildTurnTranscript({
      messages: thread.messages,
      activities: thread.activities,
      turnId,
    });
    if (!transcript.worthRecapping) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const cwd = resolveThreadWorkspaceCwd({ thread, projects }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;

    const generated = yield* textGeneration.generateTurnRecap({
      cwd,
      turnTranscript: transcript.text,
      modelSelection,
    });
    const recap = generated.recap.trim();
    if (recap.length === 0) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("turn-recap-activity"),
      threadId: thread.id,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: TURN_RECAP_ACTIVITY_KIND,
        summary: recap,
        payload: { state: event.payload.state },
        turnId,
        // Stamped with the turn's completion rather than generation time so the
        // recap sorts directly under its turn even when the next message beats
        // the model to the timeline.
        createdAt: event.createdAt,
      },
      createdAt: event.createdAt,
    });
  });

  const processEvent = (event: ProviderRuntimeEvent) =>
    event.type === "turn.completed"
      ? appendRecapFromTurnCompletion(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("turn recap reactor failed to append recap", {
              threadId: event.threadId,
              turnId: event.turnId,
              cause: Cause.pretty(cause),
            }),
          ),
        )
      : Effect.void;

  const worker = yield* makeDrainableWorker(processEvent);

  const start: TurnRecapReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        event.type === "turn.completed" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies TurnRecapReactorShape;
});

export const TurnRecapReactorLive = Layer.effect(TurnRecapReactor, make);
