import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import { buildTurnTranscript } from "./TurnRecapReactor.ts";

const TURN = TurnId.make("turn-2");
const EARLIER_TURN = TurnId.make("turn-1");

function message(input: {
  id: string;
  role: "user" | "assistant";
  text: string;
  turnId?: TurnId | null;
}): OrchestrationThread["messages"][number] {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? null,
    streaming: false,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
  };
}

function activity(input: {
  id: string;
  kind: string;
  summary: string;
  turnId?: TurnId | null;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "tool",
    kind: input.kind,
    summary: input.summary,
    payload: {},
    turnId: input.turnId ?? null,
    createdAt: "2026-08-18T12:00:00.000Z",
  };
}

describe("buildTurnTranscript", () => {
  it("pairs the turn with the user message that prompted it", () => {
    const transcript = buildTurnTranscript({
      messages: [
        message({ id: "m1", role: "user", text: "first ask" }),
        message({ id: "m2", role: "assistant", text: "first answer", turnId: EARLIER_TURN }),
        message({ id: "m3", role: "user", text: "second ask" }),
        message({ id: "m4", role: "assistant", text: "second answer", turnId: TURN }),
      ],
      activities: [
        activity({ id: "a1", kind: "tool.completed", summary: "Ran tests", turnId: TURN }),
      ],
      turnId: TURN,
    });

    expect(transcript.text).toContain("second ask");
    expect(transcript.text).not.toContain("first ask");
    expect(transcript.text).toContain("second answer");
    expect(transcript.text).not.toContain("first answer");
    expect(transcript.text).toContain("- Ran tests");
    expect(transcript.worthRecapping).toBe(true);
  });

  it("excludes other turns' work and bookkeeping activities", () => {
    const transcript = buildTurnTranscript({
      messages: [
        message({ id: "m1", role: "user", text: "do the thing" }),
        message({ id: "m2", role: "assistant", text: "done", turnId: TURN }),
      ],
      activities: [
        activity({ id: "a1", kind: "tool.completed", summary: "Edited file", turnId: TURN }),
        activity({
          id: "a2",
          kind: "tool.completed",
          summary: "Other turn work",
          turnId: EARLIER_TURN,
        }),
        activity({
          id: "a3",
          kind: "checkpoint.captured",
          summary: "Checkpoint captured",
          turnId: TURN,
        }),
        activity({ id: "a4", kind: "turn.recap", summary: "An earlier recap", turnId: TURN }),
      ],
      turnId: TURN,
    });

    expect(transcript.text).toContain("- Edited file");
    expect(transcript.text).not.toContain("Other turn work");
    expect(transcript.text).not.toContain("Checkpoint captured");
    expect(transcript.text).not.toContain("An earlier recap");
  });

  it("skips a short turn that ran no tools", () => {
    const transcript = buildTurnTranscript({
      messages: [
        message({ id: "m1", role: "user", text: "what does this flag do?" }),
        message({ id: "m2", role: "assistant", text: "It enables verbose logging.", turnId: TURN }),
      ],
      activities: [],
      turnId: TURN,
    });

    expect(transcript.worthRecapping).toBe(false);
  });

  it("recaps a toolless turn once the answer is substantial", () => {
    const transcript = buildTurnTranscript({
      messages: [
        message({ id: "m1", role: "user", text: "explain the architecture" }),
        message({ id: "m2", role: "assistant", text: "x".repeat(700), turnId: TURN }),
      ],
      activities: [],
      turnId: TURN,
    });

    expect(transcript.worthRecapping).toBe(true);
  });

  it("recaps a turn that worked but said nothing back", () => {
    const transcript = buildTurnTranscript({
      messages: [message({ id: "m1", role: "user", text: "fix the lint errors" })],
      activities: [
        activity({ id: "a1", kind: "tool.completed", summary: "Ran lint --fix", turnId: TURN }),
      ],
      turnId: TURN,
    });

    expect(transcript.worthRecapping).toBe(true);
    expect(transcript.text).toContain("fix the lint errors");
  });

  it("has nothing to recap when the turn is empty", () => {
    const transcript = buildTurnTranscript({
      messages: [],
      activities: [],
      turnId: TURN,
    });

    expect(transcript.text).toBe("");
    expect(transcript.worthRecapping).toBe(false);
  });
});
