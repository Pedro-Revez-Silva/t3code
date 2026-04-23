import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  DeleteProviderThreadMirrorInput,
  DeleteProviderThreadMirrorsByThreadInput,
  GetProviderThreadMirrorInput,
  ListProviderThreadMirrorsByThreadInput,
  ProviderThreadMirror,
  ProviderThreadMirrorRepository,
  type ProviderThreadMirrorRepositoryShape,
} from "../Services/ProviderThreadMirrors.ts";

const ProviderThreadMirrorDbRowSchema = ProviderThreadMirror.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    metadata: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const decodeMirror = Schema.decodeUnknownEffect(ProviderThreadMirror);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProviderThreadMirrorRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertMirrorRow = SqlSchema.void({
    Request: ProviderThreadMirrorDbRowSchema,
    execute: (mirror) =>
      sql`
        INSERT INTO provider_thread_mirrors (
          thread_id,
          provider_name,
          external_thread_id,
          last_seen_at,
          last_imported_at,
          last_exported_at,
          resume_cursor_json,
          runtime_payload_json,
          metadata_json
        )
        VALUES (
          ${mirror.threadId},
          ${mirror.providerName},
          ${mirror.externalThreadId},
          ${mirror.lastSeenAt},
          ${mirror.lastImportedAt},
          ${mirror.lastExportedAt},
          ${mirror.resumeCursor},
          ${mirror.runtimePayload},
          ${mirror.metadata}
        )
        ON CONFLICT (thread_id, provider_name)
        DO UPDATE SET
          external_thread_id = excluded.external_thread_id,
          last_seen_at = excluded.last_seen_at,
          last_imported_at = excluded.last_imported_at,
          last_exported_at = excluded.last_exported_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json,
          metadata_json = excluded.metadata_json
      `,
  });

  const getMirrorRowByThreadAndProvider = SqlSchema.findOneOption({
    Request: GetProviderThreadMirrorInput,
    Result: ProviderThreadMirrorDbRowSchema,
    execute: ({ threadId, providerName }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          external_thread_id AS "externalThreadId",
          last_seen_at AS "lastSeenAt",
          last_imported_at AS "lastImportedAt",
          last_exported_at AS "lastExportedAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload",
          metadata_json AS "metadata"
        FROM provider_thread_mirrors
        WHERE thread_id = ${threadId}
          AND provider_name = ${providerName}
      `,
  });

  const listMirrorRowsByThreadId = SqlSchema.findAll({
    Request: ListProviderThreadMirrorsByThreadInput,
    Result: ProviderThreadMirrorDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          external_thread_id AS "externalThreadId",
          last_seen_at AS "lastSeenAt",
          last_imported_at AS "lastImportedAt",
          last_exported_at AS "lastExportedAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload",
          metadata_json AS "metadata"
        FROM provider_thread_mirrors
        WHERE thread_id = ${threadId}
        ORDER BY provider_name ASC
      `,
  });

  const listMirrorRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderThreadMirrorDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          external_thread_id AS "externalThreadId",
          last_seen_at AS "lastSeenAt",
          last_imported_at AS "lastImportedAt",
          last_exported_at AS "lastExportedAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload",
          metadata_json AS "metadata"
        FROM provider_thread_mirrors
        ORDER BY last_seen_at ASC, thread_id ASC, provider_name ASC
      `,
  });

  const deleteMirrorsByThreadId = SqlSchema.void({
    Request: DeleteProviderThreadMirrorsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_thread_mirrors
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteMirrorByThreadAndProvider = SqlSchema.void({
    Request: DeleteProviderThreadMirrorInput,
    execute: ({ threadId, providerName }) =>
      sql`
        DELETE FROM provider_thread_mirrors
        WHERE thread_id = ${threadId}
          AND provider_name = ${providerName}
      `,
  });

  const upsert: ProviderThreadMirrorRepositoryShape["upsert"] = (mirror) =>
    upsertMirrorRow(mirror).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderThreadMirrorRepository.upsert:query",
          "ProviderThreadMirrorRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByThreadAndProvider: ProviderThreadMirrorRepositoryShape["getByThreadAndProvider"] = (
    input,
  ) =>
    getMirrorRowByThreadAndProvider(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderThreadMirrorRepository.getByThreadAndProvider:query",
          "ProviderThreadMirrorRepository.getByThreadAndProvider:decodeRow",
        ),
      ),
      Effect.flatMap((mirrorRowOption) =>
        Option.match(mirrorRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeMirror(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderThreadMirrorRepository.getByThreadAndProvider:rowToMirror",
                ),
              ),
              Effect.map((mirror) => Option.some(mirror)),
            ),
        }),
      ),
    );

  const listByThreadId: ProviderThreadMirrorRepositoryShape["listByThreadId"] = (input) =>
    listMirrorRowsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderThreadMirrorRepository.listByThreadId:query",
          "ProviderThreadMirrorRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeMirror(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderThreadMirrorRepository.listByThreadId:rowToMirror",
                ),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const list: ProviderThreadMirrorRepositoryShape["list"] = () =>
    listMirrorRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderThreadMirrorRepository.list:query",
          "ProviderThreadMirrorRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeMirror(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderThreadMirrorRepository.list:rowToMirror"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const deleteByThreadId: ProviderThreadMirrorRepositoryShape["deleteByThreadId"] = (input) =>
    deleteMirrorsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderThreadMirrorRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByThreadAndProvider: ProviderThreadMirrorRepositoryShape["deleteByThreadAndProvider"] =
    (input) =>
      deleteMirrorByThreadAndProvider(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderThreadMirrorRepository.deleteByThreadAndProvider:query"),
        ),
      );

  return {
    upsert,
    getByThreadAndProvider,
    listByThreadId,
    list,
    deleteByThreadId,
    deleteByThreadAndProvider,
  } satisfies ProviderThreadMirrorRepositoryShape;
});

export const ProviderThreadMirrorRepositoryLive = Layer.effect(
  ProviderThreadMirrorRepository,
  makeProviderThreadMirrorRepository,
);
