import { Data, Effect } from "effect";

export class MissionStorageError extends Data.TaggedError(
  "MissionStorageError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class MissionValidationError extends Data.TaggedError(
  "MissionValidationError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class MissionNotFoundError extends Data.TaggedError(
  "MissionNotFoundError",
)<{
  readonly resource: string;
  readonly id: string;
}> {
  get message() {
    return `unknown ${this.resource}: ${this.id}`;
  }
}

export const storage = <Value>(
  operation: string,
  run: () => Promise<Value>,
): Effect.Effect<Value, MissionStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MissionStorageError({ operation, cause }),
  });

export const validate = <Value>(
  run: () => Value,
): Effect.Effect<Value, MissionValidationError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new MissionValidationError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
