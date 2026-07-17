/**
 * Mission Control's single async boundary.
 *
 * Core modules return Effect values with typed failures. Pi hooks and the CLI
 * are promise-shaped host APIs, so they enter the runtime here rather than
 * scattering `runPromise` calls through storage and domain code.
 */

import { Cause, Exit, ManagedRuntime, type Effect, Layer } from "effect";

const AppLayer = Layer.empty;

export const missionRuntime = ManagedRuntime.make(AppLayer);

export async function runMission<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> {
  const exit = await missionRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
