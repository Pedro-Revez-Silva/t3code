import type { ProjectDraftSession } from "../composerDraftStore";
import { describe, expect, it, vi } from "vite-plus/test";

import { runDraftReadyBeforeNavigation } from "./useHandleNewThread";

const draft = {} as ProjectDraftSession;

describe("runDraftReadyBeforeNavigation", () => {
  it("does not navigate when onDraftReady rejects", async () => {
    const error = new Error("designation failed");
    const navigate = vi.fn(async () => undefined);

    await expect(
      runDraftReadyBeforeNavigation(
        draft,
        async () => {
          throw error;
        },
        navigate,
      ),
    ).rejects.toBe(error);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates only after onDraftReady completes", async () => {
    const calls: Array<string> = [];

    await runDraftReadyBeforeNavigation(
      draft,
      async () => {
        calls.push("ready");
      },
      async () => {
        calls.push("navigate");
      },
    );

    expect(calls).toEqual(["ready", "navigate"]);
  });
});
