import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BrainCircuitIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ChatHeaderProps {
  activeThreadTitle: string;
  environmentId: EnvironmentId;
  rightPanelOpen: boolean;
  threadId: ThreadId;
}

export function GlobalSupervisorBadge() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            aria-label="Global Supervisor"
            className="h-5 gap-1 rounded-md px-1.5 text-[10px] tracking-tight"
            tabIndex={0}
            variant="info"
          />
        }
      >
        <BrainCircuitIcon className="size-3" />
        Global Supervisor
      </TooltipTrigger>
      <TooltipPopup side="bottom">This thread is the environment's global supervisor.</TooltipPopup>
    </Tooltip>
  );
}

export const ChatHeaderContent = memo(function ChatHeaderContent({
  activeThreadTitle,
  isGlobalSupervisor,
  rightPanelOpen,
}: Pick<ChatHeaderProps, "activeThreadTitle" | "rightPanelOpen"> & {
  readonly isGlobalSupervisor: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
        {isGlobalSupervisor ? <GlobalSupervisorBadge /> : null}
      </div>
    </div>
  );
});

export const ChatHeader = memo(function ChatHeader({
  activeThreadTitle,
  environmentId,
  rightPanelOpen,
  threadId,
}: ChatHeaderProps) {
  const configurationQuery = useEnvironmentQuery(
    serverEnvironment.supervisorConfigurationLive({ environmentId, input: {} }),
  );
  return (
    <ChatHeaderContent
      activeThreadTitle={activeThreadTitle}
      isGlobalSupervisor={configurationQuery.data?.configuration.threadId === threadId}
      rightPanelOpen={rightPanelOpen}
    />
  );
});
