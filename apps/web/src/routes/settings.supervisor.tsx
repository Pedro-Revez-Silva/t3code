import { createFileRoute } from "@tanstack/react-router";

import { SupervisorSettings } from "../components/settings/SupervisorSettings";

export const Route = createFileRoute("/settings/supervisor")({
  component: SupervisorSettings,
});
