import { IsoDateTime, ProviderKind, ThreadId } from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProviderSessionRuntimeRepositoryError } from "../Errors.ts";

export const ProviderThreadMirror = Schema.Struct({
  threadId: ThreadId,
  providerName: ProviderKind,
  externalThreadId: Schema.NullOr(Schema.String),
  lastSeenAt: IsoDateTime,
  lastImportedAt: Schema.NullOr(IsoDateTime),
  lastExportedAt: Schema.NullOr(IsoDateTime),
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
  metadata: Schema.NullOr(Schema.Unknown),
});
export type ProviderThreadMirror = typeof ProviderThreadMirror.Type;

export const GetProviderThreadMirrorInput = Schema.Struct({
  threadId: ThreadId,
  providerName: ProviderKind,
});
export type GetProviderThreadMirrorInput = typeof GetProviderThreadMirrorInput.Type;

export const ListProviderThreadMirrorsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProviderThreadMirrorsByThreadInput =
  typeof ListProviderThreadMirrorsByThreadInput.Type;

export const DeleteProviderThreadMirrorsByThreadInput = ListProviderThreadMirrorsByThreadInput;
export type DeleteProviderThreadMirrorsByThreadInput =
  typeof DeleteProviderThreadMirrorsByThreadInput.Type;

export const DeleteProviderThreadMirrorInput = GetProviderThreadMirrorInput;
export type DeleteProviderThreadMirrorInput = typeof DeleteProviderThreadMirrorInput.Type;

export interface ProviderThreadMirrorRepositoryShape {
  readonly upsert: (
    mirror: ProviderThreadMirror,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  readonly getByThreadAndProvider: (
    input: GetProviderThreadMirrorInput,
  ) => Effect.Effect<Option.Option<ProviderThreadMirror>, ProviderSessionRuntimeRepositoryError>;

  readonly listByThreadId: (
    input: ListProviderThreadMirrorsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProviderThreadMirror>, ProviderSessionRuntimeRepositoryError>;

  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderThreadMirror>,
    ProviderSessionRuntimeRepositoryError
  >;

  readonly deleteByThreadId: (
    input: DeleteProviderThreadMirrorsByThreadInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  readonly deleteByThreadAndProvider: (
    input: DeleteProviderThreadMirrorInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;
}

export class ProviderThreadMirrorRepository extends Context.Service<
  ProviderThreadMirrorRepository,
  ProviderThreadMirrorRepositoryShape
>()("t3/persistence/Services/ProviderThreadMirrors/ProviderThreadMirrorRepository") {}
