import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

export interface ProviderOwnershipGuardKey {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export class ProviderOwnershipGuard extends Context.Service<
  ProviderOwnershipGuard,
  {
    readonly withLock: <A, E, R>(
      key: ProviderOwnershipGuardKey,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ProviderOwnershipGuard") {}

export const layer: Layer.Layer<ProviderOwnershipGuard> = Layer.effect(
  ProviderOwnershipGuard,
  Effect.gen(function* () {
    const locks = yield* makeKeyedSerialExecutor<string>();
    return ProviderOwnershipGuard.of({
      withLock: (key, effect) =>
        locks.withLock(`${key.threadId}\u0000${key.providerInstanceId}`, effect),
    });
  }),
);
