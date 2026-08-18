/**
 * TurnRecapReactor - Turn recap reaction service interface.
 *
 * Owns the background worker that turns a finished agent turn into a short
 * plain-English recap activity on the thread.
 *
 * @module TurnRecapReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * TurnRecapReactorShape - Service API for the turn recap reactor lifecycle.
 */
export interface TurnRecapReactorShape {
  /**
   * Start the turn recap reactor.
   *
   * The returned effect must be run in a scope so the worker fiber is
   * finalized on shutdown. Consumes provider-runtime events via an internal
   * queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * TurnRecapReactor - Service tag for the turn recap reactor worker.
 */
export class TurnRecapReactor extends Context.Service<TurnRecapReactor, TurnRecapReactorShape>()(
  "t3/orchestration/Services/TurnRecapReactor",
) {}
