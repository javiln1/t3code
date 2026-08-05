import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "../hooks/useSettings";
import {
  collectCompletedResponses,
  showResponseNotification,
  snapshotObservedTurns,
  type ObservedTurn,
} from "../responseNotifications";
import { useThreadShells } from "../state/entities";

export function ResponseNotificationCoordinator() {
  const enabled = useClientSettings((settings) => settings.notifyOnTurnComplete);
  const threads = useThreadShells();
  const navigate = useNavigate();
  const previousTurnsRef = useRef<ReadonlyMap<string, ObservedTurn> | null>(null);

  useEffect(() => {
    const previous = previousTurnsRef.current;
    previousTurnsRef.current = snapshotObservedTurns(threads);
    if (previous === null || !enabled) {
      return;
    }

    for (const completion of collectCompletedResponses({ previous, threads })) {
      showResponseNotification({
        completion,
        onOpen: (ref) => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: ref.environmentId, threadId: ref.threadId },
          });
        },
      });
    }
  }, [enabled, navigate, threads]);

  return null;
}
