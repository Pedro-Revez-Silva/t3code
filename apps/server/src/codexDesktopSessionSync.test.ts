import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { codexDesktopSessionSyncTestExports } from "./codexDesktopSessionSync";

describe("codexDesktopSessionSync", () => {
  it("parses the latest session index entry per thread and ignores invalid lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-index-"));
    const filePath = join(dir, "session_index.jsonl");

    writeFileSync(
      filePath,
      [
        "not-json",
        JSON.stringify({
          id: "thread-1",
          thread_name: "Old title",
          updated_at: "2026-04-07T19:00:00.000Z",
        }),
        JSON.stringify({
          id: "thread-1",
          thread_name: "New title",
          updated_at: "2026-04-07T20:00:00.000Z",
        }),
        JSON.stringify({
          id: "thread-2",
          thread_name: "Second thread",
          updated_at: "2026-04-07T18:00:00.000Z",
        }),
      ].join("\n"),
      "utf8",
    );

    const sessionIndex = codexDesktopSessionSyncTestExports.parseSessionIndex(filePath);

    expect(sessionIndex.get("thread-1")).toEqual({
      threadName: "New title",
      updatedAt: "2026-04-07T20:00:00.000Z",
    });
    expect(sessionIndex.get("thread-2")).toEqual({
      threadName: "Second thread",
      updatedAt: "2026-04-07T18:00:00.000Z",
    });
  });

  it("imports Codex session files and prefers the newest timestamp from the rollout", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-session-"));
    const filePath = join(dir, "thread.jsonl");
    const sessionIndex = new Map([
      [
        "thread-1",
        {
          threadName: "Indexed title",
          updatedAt: "2026-04-07T18:05:00.000Z",
        },
      ],
    ]);

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-07T18:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: "/Users/pedrosilva/project-a",
            timestamp: "2026-04-07T18:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:00.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4",
            approval_policy: "on-request",
            collaboration_mode: { mode: "plan" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:20.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "hello from codex",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:01:30.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "working on it",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:06:00.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "done",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-07T18:06:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const session = codexDesktopSessionSyncTestExports.parseSessionFile(filePath, sessionIndex);

    expect(session).toMatchObject({
      threadId: "thread-1",
      workspaceRoot: "/Users/pedrosilva/project-a",
      title: "Indexed title",
      model: "gpt-5.4",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      latestTurnId: "turn-1",
      activeTurnId: null,
      status: "idle",
      updatedAt: "2026-04-07T18:06:10.000Z",
    });
    expect(session?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "hello from codex",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "done",
        turnId: "turn-1",
      }),
    ]);
    expect(session?.activities).toEqual([
      expect.objectContaining({
        kind: "codex.commentary",
        summary: "working on it",
      }),
    ]);
  });

  it("appends only changed session index entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sync-append-"));
    const filePath = join(dir, "session_index.jsonl");

    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: "thread-1",
        thread_name: "Current title",
        updated_at: "2026-04-07T18:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const sessionIndex = codexDesktopSessionSyncTestExports.parseSessionIndex(filePath);
    const changed = codexDesktopSessionSyncTestExports.appendSessionIndexUpdates(filePath, sessionIndex, [
      {
        threadId: "thread-1",
        title: "Current title",
        updatedAt: "2026-04-07T18:00:00.000Z",
      },
      {
        threadId: "thread-2",
        title: "New thread",
        updatedAt: "2026-04-07T18:01:00.000Z",
      },
    ] as never);

    expect(changed).toBe(true);
    expect(sessionIndex.get("thread-2")).toEqual({
      threadName: "New thread",
      updatedAt: "2026-04-07T18:01:00.000Z",
    });
    const lines = readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      id: "thread-2",
      thread_name: "New thread",
      updated_at: "2026-04-07T18:01:00.000Z",
    });
  });
});
