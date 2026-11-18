import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { backfillOutsideAppLaunches, OUTSIDE_APP_LABEL } from "./backfillOutsideAppLaunches.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for the backfill"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "outside-app-backfill" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createLaunch = Effect.fn(function* (
  name: string,
  options: {
    readonly senderThreadId?: string;
    readonly payloadPatch?: string;
    readonly threadId?: string;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const threadId = ThreadId.make(options.threadId ?? `mcp:launch:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make("project:backfill"),
    title: name,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "mcp",
  });
  if (options.payloadPatch !== undefined) {
    yield* sql.unsafe(
      `UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, ${options.payloadPatch}) WHERE thread_id = ?`,
      [threadId],
    );
  }
  const firstMessage = JSON.stringify({
    text: "Do the thing",
    ...(options.senderThreadId === undefined ? {} : { senderThreadId: options.senderThreadId }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
    VALUES
      (${`first:${name}`}, ${threadId}, NULL, NULL, 'user', 0, '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z', ${firstMessage}),
      (${`later:${name}`}, ${threadId}, NULL, NULL, 'user', 0, '1970-01-01T00:00:02.000Z', '1970-01-01T00:00:02.000Z', '{"text":"later","senderThreadId":"thread:other"}')
  `;
  return threadId;
});

const launchedBy = Effect.fn(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly label: string | null }>`
    SELECT json_extract(payload_json, '$.launchedByClient') AS label
    FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
  `;
  return rows[0]?.label;
});

it.effect("tags pre-tag outside launches once and keeps the tag through later events", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outside = yield* createLaunch("outside");
    // Without a clientRequestId, t3_thread_launch ids are `mcp:<uuid>`.
    const unkeyed = yield* createLaunch("unkeyed", { threadId: "mcp:unkeyed" });
    const fromThread = yield* createLaunch("from-thread", { senderThreadId: "thread:sender" });
    const fork = yield* createLaunch("fork", {
      payloadPatch: `'$.lineage.parentThreadId', 'thread:parent'`,
    });
    const linked = yield* createLaunch("linked", { payloadPatch: `'$.linkOrigin', json('{}')` });
    const tagged = yield* createLaunch("tagged", {
      payloadPatch: `'$.launchedByClient', 'Cursor'`,
    });
    const recent = yield* createLaunch("recent");
    yield* sql`
      UPDATE orchestration_v2_projection_threads SET created_at = '2026-11-17T00:00:00.000Z'
      WHERE thread_id = ${recent}
    `;

    const payloads = sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id
    `;
    yield* backfillOutsideAppLaunches();
    const afterFirstRun = yield* payloads;
    yield* backfillOutsideAppLaunches();
    assert.deepEqual(yield* payloads, afterFirstRun);

    assert.equal(yield* launchedBy(outside), OUTSIDE_APP_LABEL);
    assert.equal(yield* launchedBy(unkeyed), OUTSIDE_APP_LABEL);
    assert.isNull(yield* launchedBy(fromThread));
    assert.isNull(yield* launchedBy(fork));
    assert.isNull(yield* launchedBy(linked));
    assert.equal(yield* launchedBy(tagged), "Cursor");
    assert.isNull(yield* launchedBy(recent));

    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename-outside"),
      threadId: outside,
      title: "Renamed",
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* projections.getThread(outside);
    assert.equal(thread.title, "Renamed");
    assert.equal(thread.launchedByClient, OUTSIDE_APP_LABEL);
    assert.equal((yield* projections.getThreadShell(outside))?.launchedByClient, OUTSIDE_APP_LABEL);
  }).pipe(Effect.provide(layerTest)),
);
