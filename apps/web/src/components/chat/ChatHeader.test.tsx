import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChatHeaderContent } from "./ChatHeader";

describe("ChatHeader", () => {
  it("shows an accessible Global Supervisor badge for the designated thread", () => {
    const markup = renderToStaticMarkup(
      <ChatHeaderContent
        activeThreadTitle="Control plane"
        isGlobalSupervisor
        rightPanelOpen={false}
      />,
    );

    expect(markup).toContain("Global Supervisor");
    expect(markup).toContain('aria-label="Global Supervisor"');
    expect(markup).toContain('tabindex="0"');
  });

  it("keeps ordinary thread headers free of the badge", () => {
    const markup = renderToStaticMarkup(
      <ChatHeaderContent
        activeThreadTitle="Regular thread"
        isGlobalSupervisor={false}
        rightPanelOpen={false}
      />,
    );

    expect(markup).not.toContain("Global Supervisor");
  });
});
