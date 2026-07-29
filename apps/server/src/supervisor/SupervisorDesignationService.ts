import {
  type SupervisorConfigurationReadResult,
  type SupervisorConfigurationUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { SupervisorControlPlaneService } from "./SupervisorControlPlaneService.ts";

export class SupervisorDesignationService extends Context.Service<
  SupervisorDesignationService,
  {
    readonly update: (
      input: SupervisorConfigurationUpdateInput,
    ) => ReturnType<SupervisorControlPlaneService["Service"]["updateConfiguration"]>;
  }
>()("t3/supervisor/SupervisorDesignationService") {}

const make = Effect.gen(function* () {
  const controlPlane = yield* SupervisorControlPlaneService;
  const mcpSessions = yield* McpSessionRegistry;

  return SupervisorDesignationService.of({
    update: (input) =>
      Effect.gen(function* () {
        const previous = yield* controlPlane.readConfiguration();
        const updated: SupervisorConfigurationReadResult =
          yield* controlPlane.updateConfiguration(input);
        yield* mcpSessions.refreshSupervisorDesignation({
          previousThreadId: previous.configuration.threadId,
          nextThreadId: updated.configuration.threadId,
        });
        return updated;
      }),
  });
});

export const layer: Layer.Layer<
  SupervisorDesignationService,
  never,
  McpSessionRegistry | SupervisorControlPlaneService
> = Layer.effect(SupervisorDesignationService, make);
