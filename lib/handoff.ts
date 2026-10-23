import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import { projectLaunchEnvironment, worktreeLaunchEnvironment } from "./worktree-launch";

type ExecutionFields = "providerId" | "model" | "reasoningLevel" | "permissionMode" | "executionInputSources";
// Omitted execution fields fall back to BB's remembered project defaults, exactly
// as an unseeded composer would. Only the bot's saved preset is made explicit.
export type BotStartRequest = Omit<NewThreadRequest, ExecutionFields> & Partial<Pick<NewThreadRequest, ExecutionFields>>;

// A spawned handoff follows the same defaults as the bot's generic + action:
// an owned work project (checkout, or a fresh worktree when preferred) on the
// bot's machine, otherwise a personal chat. Starter prompts never apply here:
// the delegated message is the first prompt.
export function handoffStartRequest(bot: Pick<BotMetadata, "hostId" | "launchPreset">, ownedProjectId: string | null, personalProjectId: string, input: NewThreadRequest["input"]): BotStartRequest {
  const preset = bot.launchPreset ?? null;
  const execution = preset?.execution ?? null;
  const environment: NewThreadRequest["environment"] = ownedProjectId
    ? preset?.workspace === "worktree" ? worktreeLaunchEnvironment(bot.hostId) : projectLaunchEnvironment(bot.hostId)
    : { type: "host", hostId: bot.hostId, workspace: { type: "personal" } };
  return {
    projectId: ownedProjectId ?? personalProjectId, environment, input,
    ...(execution ? {
      providerId: execution.providerId, model: execution.model, reasoningLevel: execution.reasoningLevel,
      ...(execution.serviceTier === undefined ? {} : { serviceTier: execution.serviceTier }),
      ...(execution.permissionMode === null ? {} : { permissionMode: execution.permissionMode }),
      executionInputSources: {
        providerId: "explicit", model: "explicit", reasoningLevel: "explicit",
        ...(execution.serviceTier === undefined ? {} : { serviceTier: "explicit" as const }),
        ...(execution.permissionMode === null ? {} : { permissionMode: "explicit" as const }),
      },
    } : {}),
  };
}
