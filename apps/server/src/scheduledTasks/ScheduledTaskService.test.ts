import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { RuntimeMutationAuthority } from "../supervisor/SupervisorAuthority.ts";
import { layer, ScheduledTaskService } from "./ScheduledTaskService.ts";

const taskId = ScheduledTaskId.make("scheduled-task:runtime-authority-existing");
const input = {
  id: taskId,
  title: "Existing task",
  prompt: "Keep the persisted task unchanged.",
  enabled: false,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project:runtime-authority"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
} satisfies ScheduledTaskUpsertInput;

const staleAuthority = {
  threadId: ThreadId.make("thread:stale-runtime-authority"),
  runtimeProviderSessionId: ProviderSessionId.make("provider-session:stale-runtime-authority"),
  providerInstanceId: ProviderInstanceId.make("codex"),
} satisfies RuntimeMutationAuthority;

const testLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      SqlitePersistenceMemory,
      NodeServices.layer,
      Layer.mock(ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService)({}),
    ),
  ),
);

it.effect("rejects stale runtime authority inside every scheduled-task mutation", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService;
    yield* service.upsert(input);

    const createExit = yield* Effect.exit(
      service.upsert(
        {
          ...input,
          id: ScheduledTaskId.make("scheduled-task:runtime-authority-new"),
          title: "Must not be created",
        },
        staleAuthority,
      ),
    );
    const updateExit = yield* Effect.exit(
      service.upsert({ ...input, title: "Must not replace the title" }, staleAuthority),
    );
    const enableExit = yield* Effect.exit(
      service.setEnabled({ id: taskId, enabled: true }, staleAuthority),
    );
    const deleteExit = yield* Effect.exit(service.delete({ id: taskId }, staleAuthority));

    assert.isTrue(Exit.isFailure(createExit));
    assert.isTrue(Exit.isFailure(updateExit));
    assert.isTrue(Exit.isFailure(enableExit));
    assert.isTrue(Exit.isFailure(deleteExit));
    const { tasks } = yield* service.list();
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0]?.id, taskId);
    assert.strictEqual(tasks[0]?.title, input.title);
    assert.isFalse(tasks[0]?.enabled);
  }).pipe(Effect.provide(testLayer)),
);
