import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const OUTSIDE_APP_LABEL = "Outside app";

// Fork-only repair kept out of the numbered migrations so upstream's next id never collides.
// Launches before Nov 17 2026 predate `launchedByClient`; a first message without
// `senderThreadId` came from an outside MCP client, not another thread.
export const backfillOutsideAppLaunches = Effect.fn("backfillOutsideAppLaunches")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_threads AS thread
    SET payload_json = json_set(payload_json, '$.launchedByClient', ${OUTSIDE_APP_LABEL})
    WHERE thread.thread_id LIKE 'mcp:%'
      AND thread.created_at < '2026-11-17T00:00:00.000Z'
      AND CASE WHEN json_valid(thread.payload_json) THEN
        json_extract(thread.payload_json, '$.lineage.parentThreadId') IS NULL
        AND json_extract(thread.payload_json, '$.linkOrigin') IS NULL
        AND json_extract(thread.payload_json, '$.launchedByClient') IS NULL
        AND (
          SELECT CASE WHEN json_valid(message.payload_json)
            THEN json_extract(message.payload_json, '$.senderThreadId') IS NULL ELSE 0 END
          FROM orchestration_v2_projection_messages AS message
          WHERE message.thread_id = thread.thread_id AND message.role = 'user'
          ORDER BY message.created_at, message.message_id
          LIMIT 1
        )
      ELSE 0 END
  `;
});
