import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (
  now: () => number,
  httpServer = fakeHttpServer,
  globalSupervisorThreadId?: ThreadId,
) =>
  McpSessionRegistry.__testing
    .make({ now, globalSupervisorThreadId })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(new Set(["preview", "orchestration", "worktree"]));

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        runtimeProviderSessionId: ProviderSessionId.make(`runtime-session-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("keeps credentials valid until they are explicitly revoked", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.providerSessionId).toBe(issued.config.providerSessionId);
    timestamp += 365 * 24 * 60 * 60 * 1_000;
    expect(yield* registry.resolve(token)).toEqual(resolved);

    yield* registry.revokeProviderSession(issued.config.providerSessionId);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("grants global orchestration only to the configured supervisor thread", () =>
  Effect.gen(function* () {
    const supervisorThreadId = ThreadId.make("thread-supervisor");
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, supervisorThreadId);
    const supervisor = yield* registry.issue({
      threadId: supervisorThreadId,
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-supervisor"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const ordinary = yield* registry.issue({
      threadId: ThreadId.make("thread-ordinary"),
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-ordinary"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });

    const supervisorScope = yield* registry.resolve(
      supervisor.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    const ordinaryScope = yield* registry.resolve(
      ordinary.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(supervisorScope?.capabilities.has("global-orchestration")).toBe(true);
    expect(supervisorScope?.runtimeProviderSessionId).toBe("runtime-session-supervisor");
    expect(ordinaryScope?.capabilities).toEqual(new Set(["preview", "orchestration", "worktree"]));
  }),
);

it.effect("refreshes existing credentials when supervisor designation changes", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const previousThreadId = ThreadId.make("thread-previous-supervisor");
    const nextThreadId = ThreadId.make("thread-promoted-supervisor");
    const previous = yield* registry.issue({
      threadId: previousThreadId,
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-previous"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const next = yield* registry.issue({
      threadId: nextThreadId,
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-promoted"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const previousToken = previous.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const nextToken = next.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* registry.refreshSupervisorDesignation({
      previousThreadId: null,
      nextThreadId: previousThreadId,
    });
    expect((yield* registry.resolve(previousToken))?.capabilities.has("global-orchestration")).toBe(
      true,
    );
    yield* registry.refreshSupervisorDesignation({ previousThreadId, nextThreadId });
    expect((yield* registry.resolve(previousToken))?.capabilities.has("global-orchestration")).toBe(
      false,
    );
    expect((yield* registry.resolve(nextToken))?.capabilities.has("global-orchestration")).toBe(
      true,
    );
    expect((yield* registry.resolve(nextToken))?.runtimeProviderSessionId).toBe(
      "runtime-session-promoted",
    );
  }),
);

it.effect("revokes an ordinary credential superseded by takeover before supervisor promotion", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-ordinary-takeover-promoted");
    const ordinary = yield* registry.issue({
      threadId,
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-before-takeover"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const takeover = yield* registry.issue({
      threadId,
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-after-takeover"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const ordinaryToken = ordinary.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const takeoverToken = takeover.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* registry.refreshSupervisorDesignation({
      previousThreadId: null,
      nextThreadId: threadId,
    });

    expect(yield* registry.resolve(ordinaryToken)).toBeUndefined();
    const promoted = yield* registry.resolve(takeoverToken);
    expect(promoted?.runtimeProviderSessionId).toBe("runtime-session-after-takeover");
    expect(promoted?.capabilities.has("global-orchestration")).toBe(true);
  }),
);

it.effect("does not advertise global orchestration when persisted supervision is disabled", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing
      .make({
        globalSupervisorThreadId: ThreadId.make("thread-env-bootstrap"),
        isDesignatedSupervisor: () => Effect.succeed(false),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-env-bootstrap"),
      runtimeProviderSessionId: ProviderSessionId.make("runtime-session-disabled"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const scope = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(scope?.capabilities.has("global-orchestration")).toBe(false);
  }),
);
