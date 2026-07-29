import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import {
  layer as providerSessionGenerationStoreLayer,
  ProviderSessionGenerationStore,
} from "./ProviderSessionGenerationStore.ts";

it.effect(
  "persists quarantine generations across store reconstruction and rotates shared ids",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:provider-session-generation");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const sharedProviderSessionId = ProviderSessionId.make(
        "provider-session:provider-instance:codex:shared",
      );

      const firstGeneration = yield* Effect.gen(function* () {
        const generations = yield* ProviderSessionGenerationStore;
        assert.equal(yield* generations.current({ threadId, providerInstanceId }), 0);
        return yield* generations.quarantine({
          threadId,
          providerInstanceId,
          providerSessionId: sharedProviderSessionId,
          reason: "unconfirmed provider termination",
        });
      }).pipe(Effect.provide(providerSessionGenerationStoreLayer));
      assert.equal(firstGeneration, 1);

      const persistedGeneration = yield* Effect.gen(function* () {
        const generations = yield* ProviderSessionGenerationStore;
        return yield* generations.current({ threadId, providerInstanceId });
      }).pipe(Effect.provide(providerSessionGenerationStoreLayer));
      assert.equal(persistedGeneration, 1);

      const idAllocator = yield* IdAllocatorV2;
      const initialId = idAllocator.derive.providerSession({
        threadId,
        providerInstanceId,
        generation: 0,
      });
      const reboundId = idAllocator.derive.providerSession({
        threadId,
        providerInstanceId,
        generation: persistedGeneration,
      });
      assert.equal(initialId, sharedProviderSessionId);
      assert.notEqual(reboundId, initialId);
      assert.include(reboundId, "generation:1");
    }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, SqlitePersistenceMemory))),
);
