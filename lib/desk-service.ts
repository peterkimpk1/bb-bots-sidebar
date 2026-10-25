import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";
import { nextTimestamp } from "./bot-store";
import type { BotStartRequest } from "./handoff";
import { conversationRoots, orderConversations } from "./conversation-order";
import { ownedConversationProjectId } from "./worktree-launch";
import { deskHandover, deskSettings, deskSettingsChange, deskStartRequest, deskTitle, effectiveDesk, type DeskModel, type DeskOverride, type DeskSource, type LiveChild } from "./desk";

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Settings = BotMetadata["settings"];

export type DeskReplaceRequest = { botIds: string[]; desk?: DeskModel | null | undefined; until?: string | null | undefined; skipThreadId?: string | undefined };
export type DeskReplaceResult = {
  botId: string; oldDeskId: string | null; newDeskId: string | null; moved: string[]; automationsRetargeted: string[];
  /** Automations that still point at the old desk and must be retargeted by hand. */
  automationsPending?: string[]; skipped?: string; error?: string;
};
export type DeskStatus = {
  botId: string; name: string; deskId: string | null; deskTitle: string | null;
  providerId: string | null; model: string | null; reasoningLevel: string | null; contextTokens: number | null; liveChildren: number;
  desk: DeskModel | null; deskOverride: DeskOverride | null; effective: DeskModel | null; effectiveSource: DeskSource;
};

export interface DeskDeps {
  bb: BbPluginApi; store: BotStore;
  prepare(botId: string): Promise<BotMetadata>;
  personalProjectId(): Promise<string>;
  resolveOwner(threadId: string, persist?: boolean): Promise<string | null>;
  start(botId: string, request: BotStartRequest, title: string): Promise<{ threadId: string }>;
  changeSettings(botId: string, set: Settings, unset: string[]): Promise<void>;
  publish(): void;
}

const AUTOMATIONS_PLUGIN_ID = "automations";
const automationSchema = z.looseObject({
  id: z.string(), projectId: z.string(), name: z.string(),
  execution: z.looseObject({ mode: z.string(), targetThreadId: z.string().optional(), env: z.record(z.string(), z.string()).optional() }).optional(),
});
const overviewSchema = z.looseObject({ automations: z.array(z.looseObject({ automation: automationSchema })) });
const scriptSchema = z.looseObject({
  execution: z.looseObject({
    mode: z.literal("script"), script: z.string().min(1), interpreter: z.string().optional(), timeoutMs: z.number(),
    env: z.record(z.string(), z.string()).optional(), workingDirectory: z.json(),
  }),
});

export function createDeskService({ bb, store, prepare, personalProjectId, resolveOwner, start, changeSettings, publish }: DeskDeps) {
  async function liveThreads(): Promise<ListedThread[]> {
    const rows: ListedThread[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, offset, limit: 100 });
      rows.push(...page.filter((row) => !row.archivedAt && !row.deletedAt));
      if (page.length < 100) break;
    }
    return rows;
  }
  // One pass over live threads; ownership follows the nearest bound ancestor,
  // exactly as listBotConversations resolves it, without a get per row.
  async function desksByBot(threads: readonly ListedThread[]) {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const direct = new Map(store.bindings().map((binding) => [binding.threadId, binding.botId]));
    const rows = new Map<string, ListedThread[]>();
    for (const thread of threads) {
      if (thread.visibility === "hidden") continue;
      let id: string | null = thread.id;
      let owner: string | null = null;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        owner = direct.get(id) ?? null;
        if (owner) break;
        const ancestor = byId.get(id);
        if (!ancestor) { owner = await resolveOwner(id, false); break; }
        id = ancestor.parentThreadId ?? ancestor.sourceThreadId;
      }
      if (owner) rows.set(owner, [...(rows.get(owner) ?? []), thread]);
    }
    return new Map(store.list().map((bot) => [bot.id, conversationRoots(orderConversations(rows.get(bot.id) ?? [], bot.threadOrder))[0] ?? null]));
  }
  function children(threads: readonly ListedThread[], parentId: string): LiveChild[] {
    return threads.filter((thread) => thread.parentThreadId === parentId).map((thread) => ({ id: thread.id, title: thread.title ?? thread.titleFallback, status: thread.status }));
  }
  async function runningModel(threadId: string) {
    const options = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
    return options ? { model: options.model, reasoningLevel: options.reasoningLevel, serviceTier: options.serviceTier } : null;
  }

  // A desk on project defaults: check-ins follow whatever the new desk runs.
  async function runningDesk(threadId: string): Promise<DeskModel | null> {
    const options = await runningModel(threadId);
    if (!options) return null;
    const { providerId } = await bb.sdk.threads.get({ threadId });
    return { providerId, model: options.model, reasoningLevel: options.reasoningLevel, ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}) };
  }

  async function status(): Promise<DeskStatus[]> {
    const threads = await liveThreads();
    const desks = await desksByBot(threads);
    return Promise.all(store.list().map(async (bot) => {
      const desk = desks.get(bot.id) ?? null;
      const effective = effectiveDesk(bot);
      const base = { botId: bot.id, name: bot.name, ...deskSettings(bot.settings), effective: effective.model, effectiveSource: effective.source };
      if (!desk) return { ...base, deskId: null, deskTitle: null, providerId: null, model: null, reasoningLevel: null, contextTokens: null, liveChildren: 0 };
      const [running, context] = await Promise.all([runningModel(desk.id), bb.sdk.threads.context({ threadId: desk.id }).catch(() => null)]);
      return {
        ...base, deskId: desk.id, deskTitle: desk.title ?? desk.titleFallback, providerId: desk.providerId,
        model: running?.model ?? context?.usage?.snapshot?.model ?? null, reasoningLevel: running?.reasoningLevel ?? null,
        contextTokens: context?.usage?.usedTokens ?? null, liveChildren: children(threads, desk.id).length,
      };
    }));
  }

  // Check-ins re-prompt the desk, so they follow it to the new thread and run
  // on its model; watchers carry the desk in their environment.
  async function retargetAutomations(oldDeskId: string, newDeskId: string, model: DeskModel | null): Promise<{ retargeted: string[]; pending: string[] }> {
    const call = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) => bb.sdk.plugins.callRpc({ pluginId: AUTOMATIONS_PLUGIN_ID, method, input: input as never, outputSchema });
    let automations: z.infer<typeof automationSchema>[];
    try {
      automations = (await call("automations_overview", null, overviewSchema)).automations.map((entry) => entry.automation);
    } catch (error) {
      return { retargeted: [], pending: [`every automation that targets ${oldDeskId} (could not list automations: ${error instanceof Error ? error.message : String(error)})`] };
    }
    const retargeted: string[] = [], pending: string[] = [];
    for (const automation of automations) {
      const execution = automation.execution;
      const agent = execution?.mode === "agent" && execution.targetThreadId === oldDeskId;
      const script = execution?.mode === "script" && Object.values(execution.env ?? {}).includes(oldDeskId);
      if (!agent && !script) continue;
      const key = { projectId: automation.projectId, automationId: automation.id };
      try {
        if (agent) {
          await call("automations_update", { ...key, agent: {
            target: { type: "target-thread", threadId: newDeskId },
            ...(model ? { providerId: model.providerId, model: model.model, reasoningLevel: model.reasoningLevel, serviceTier: model.serviceTier ?? null } : {}),
          } }, z.unknown());
        } else {
          const { execution: current } = await call("automations_get", key, scriptSchema);
          const env = Object.fromEntries(Object.entries(current.env ?? {}).map(([name, value]) => [name, value === oldDeskId ? newDeskId : value]));
          await call("automations_update", { ...key, execution: {
            mode: "script", script: current.script, timeoutMs: current.timeoutMs, env, workingDirectory: current.workingDirectory,
            ...(current.interpreter ? { interpreter: current.interpreter } : {}),
          } }, z.unknown());
        }
        retargeted.push(automation.name);
      } catch (error) {
        pending.push(`${automation.name} (${automation.id}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { retargeted, pending };
  }

  async function newDeskProject(bot: BotMetadata, personal: string, oldProjectId: string | null) {
    if (oldProjectId) return oldProjectId;
    const legacyHomes = new Set(store.list().map((entry) => entry.legacyHomeProjectId));
    const projects = (await bb.sdk.projects.list()).filter((project) => project.kind === "standard" && !legacyHomes.has(project.id));
    return ownedConversationProjectId({ bot, projects, owners: store.projectOwners(), personalProjectId: personal, main: null }) ?? personal;
  }

  async function replaceOne(botId: string, request: DeskReplaceRequest, threads: readonly ListedThread[], old: ListedThread | null, now: number): Promise<DeskReplaceResult> {
    const result: DeskReplaceResult = { botId, oldDeskId: old?.id ?? null, newDeskId: null, moved: [], automationsRetargeted: [] };
    try {
      const change = deskSettingsChange(request.desk, request.until, now);
      if (change) await changeSettings(botId, change.set, change.unset);
      if (old && old.id === request.skipThreadId) return { ...result, skipped: "This desk is the conversation asking for the replacement; replace it from another conversation." };
      const bot = await prepare(botId);
      const { model } = effectiveDesk(bot, now);
      const personal = await personalProjectId();
      const live = old ? children(threads, old.id) : [];
      const projectId = await newDeskProject(bot, personal, old?.projectId ?? null);
      const input = [{ type: "text" as const, text: deskHandover(old?.id ?? null, live), mentions: [] }];
      const created = await start(botId, deskStartRequest(bot, model, projectId, personal, input), deskTitle(bot.name));
      result.newDeskId = created.threadId;
      // Archiving a thread archives its children: move live work first.
      for (const child of live) {
        await bb.sdk.threads.update({ threadId: child.id, parentThreadId: created.threadId });
        result.moved.push(child.id);
      }
      if (old) await bb.sdk.threads.archive({ threadId: old.id });
      store.mutate(botId, (latest) => ({
        ...latest, mainThreadId: created.threadId,
        threadOrder: [created.threadId, ...(latest.threadOrder ?? []).filter((id) => id !== created.threadId && id !== old?.id)],
        updatedAt: nextTimestamp(latest.updatedAt),
      }));
      publish();
      if (old) {
        const automations = await retargetAutomations(old.id, created.threadId, model ?? await runningDesk(created.threadId));
        result.automationsRetargeted = automations.retargeted;
        if (automations.pending.length) result.automationsPending = automations.pending;
      }
      return result;
    } catch (error) {
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function replace(request: DeskReplaceRequest): Promise<DeskReplaceResult[]> {
    const botIds = [...new Set(request.botIds)];
    for (const botId of botIds) store.require(botId);
    const now = Date.now();
    // Validate the request once, before any bot changes.
    deskSettingsChange(request.desk, request.until, now);
    const threads = await liveThreads();
    const desks = await desksByBot(threads);
    const results: DeskReplaceResult[] = [];
    // Sequential: each replacement spawns, moves and archives threads.
    for (const botId of botIds) results.push(await replaceOne(botId, request, threads, desks.get(botId) ?? null, now));
    return results;
  }

  return { status, replace };
}
export type DeskService = ReturnType<typeof createDeskService>;
