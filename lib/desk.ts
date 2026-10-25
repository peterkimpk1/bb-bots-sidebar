import { z } from "zod";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import type { BotStartRequest } from "./handoff";
import { projectLaunchEnvironment } from "./worktree-launch";

// A bot's desk is its first ordered conversation: bb bots messages and
// scheduled check-ins land there. It may run on a lighter model than the bot's
// own work, so its model lives in settings.json beside the launch preset.
const deskFields = {
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: z.string().trim().min(1),
  serviceTier: z.string().trim().min(1).optional(),
};
export const deskModelInputSchema = z.object(deskFields).strict();
export type DeskModel = z.infer<typeof deskModelInputSchema>;
// settings.json is hand-editable; read leniently and ignore anything unusable.
const storedDesk = z.object(deskFields);
const storedOverride = storedDesk.extend({ until: z.iso.datetime({ offset: true }) });
export type DeskOverride = DeskModel & { until: string };

export const DESK_SETTING = "desk";
export const DESK_OVERRIDE_SETTING = "deskOverride";

function pickDesk(value: { providerId: string; model: string; reasoningLevel: string; serviceTier?: string | undefined }): DeskModel {
  return { providerId: value.providerId, model: value.model, reasoningLevel: value.reasoningLevel, ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}) };
}

export function deskSettings(settings: BotMetadata["settings"]): { desk: DeskModel | null; deskOverride: DeskOverride | null } {
  const desk = storedDesk.safeParse(settings[DESK_SETTING]);
  const override = storedOverride.safeParse(settings[DESK_OVERRIDE_SETTING]);
  return {
    desk: desk.success ? pickDesk(desk.data) : null,
    deskOverride: override.success ? { ...pickDesk(override.data), until: override.data.until } : null,
  };
}

export type DeskSource = "override" | "desk" | "launch" | "default";
/** Active override, else the bot's desk, else its launch preset, else project defaults (null). */
export function effectiveDesk(bot: Pick<BotMetadata, "settings" | "launchPreset">, now = Date.now()): { model: DeskModel | null; source: DeskSource } {
  const { desk, deskOverride } = deskSettings(bot.settings);
  if (deskOverride && Date.parse(deskOverride.until) > now) {
    const { until: _until, ...model } = deskOverride;
    return { model, source: "override" };
  }
  if (desk) return { model: desk, source: "desk" };
  const execution = bot.launchPreset?.execution;
  if (execution) return { model: pickDesk(execution), source: "launch" };
  return { model: null, source: "default" };
}

/**
 * Settings changes for a desk_replace request. A permanent choice clears any
 * temporary override, or the override would keep winning until it expires.
 */
export function deskSettingsChange(desk: DeskModel | null | undefined, until: string | null | undefined, now = Date.now()): { set: BotMetadata["settings"]; unset: string[] } | null {
  if (!desk) {
    if (until) throw new Error("--until needs a desk model: give a provider, model and reasoning level.");
    return null;
  }
  if (until) {
    if (!(Date.parse(until) > now)) throw new Error("until must be in the future.");
    return { set: { [DESK_OVERRIDE_SETTING]: { ...desk, until } }, unset: [] };
  }
  return { set: { [DESK_SETTING]: { ...desk } }, unset: [DESK_OVERRIDE_SETTING] };
}

export const DESK_BOOT_PROMPT =
  "This is your desk conversation: bb bots messages and scheduled check-ins arrive here. " +
  "Read your bot state with bot_read_state and load the bot-protocol skill. " +
  "Reply in at most three lines: your role, your check-in schedule, and anything missing from your charter. " +
  "Do not start other work.";

export type LiveChild = { id: string; title: string | null; status: string };
export function deskHandover(oldDeskId: string | null, live: readonly LiveChild[]): string {
  if (!oldDeskId) return DESK_BOOT_PROMPT;
  const moved = live.map((child) => `${child.id} (${(child.title || "untitled").slice(0, 60)}, ${child.status})`).join("; ") || "none";
  return `${DESK_BOOT_PROMPT}\n\nYou replace the previous desk ${oldDeskId}, now archived. Your memory carries durable facts. ` +
    `Live work moved under you: ${moved}. ` +
    `For recent context run \`bb thread log ${oldDeskId} --format minimal --limit 15\`; do not read it in full.`;
}

export const deskTitle = (botName: string) => `${botName} desk`;

/**
 * A desk starts in the old desk's project on the bot's machine: its personal
 * workspace when that project is the personal one, else the project checkout.
 */
export function deskStartRequest(bot: Pick<BotMetadata, "hostId" | "launchPreset">, desk: DeskModel | null, projectId: string, personalProjectId: string, input: NewThreadRequest["input"]): BotStartRequest {
  const environment: NewThreadRequest["environment"] = projectId === personalProjectId
    ? { type: "host", hostId: bot.hostId, workspace: { type: "personal" } }
    : projectLaunchEnvironment(bot.hostId);
  if (!desk) return { projectId, environment, input };
  // Desks relay bb commands unattended, so they default to auto approval.
  const permissionMode = bot.launchPreset?.execution?.permissionMode ?? "auto";
  return {
    projectId, environment, input,
    providerId: desk.providerId, model: desk.model, reasoningLevel: desk.reasoningLevel, permissionMode,
    ...(desk.serviceTier ? { serviceTier: desk.serviceTier } : {}),
    executionInputSources: {
      providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit",
      ...(desk.serviceTier ? { serviceTier: "explicit" as const } : {}),
    },
  };
}
