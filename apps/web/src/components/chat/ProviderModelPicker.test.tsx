import { ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderModelPicker } from "./ProviderModelPicker";

describe("ProviderModelPicker", () => {
  it("forwards an accessible name to its custom trigger", () => {
    const markup = renderToStaticMarkup(
      <ProviderModelPicker
        activeInstanceId={ProviderInstanceId.make("codex")}
        model="gpt-5.4"
        lockedProvider={null}
        instanceEntries={[]}
        modelOptionsByInstance={new Map()}
        triggerAriaLabel="Provider and model override for API project"
        onInstanceModelChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Provider and model override for API project"');
  });
});
