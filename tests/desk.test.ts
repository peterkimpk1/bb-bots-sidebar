import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend, PERSONAL_ID } from "./backend-fixture";
import { deskSettingsChange, effectiveDesk } from "../lib/desk";
import type { BotMetadata } from "../contract";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

const SOL = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" };
const SONNET = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "high" };

type Automation = { id: string; projectId: string; name: string; execution: Record<string, unknown> };
async function setup() {
  const host = await backend(); hosts.push(host);
  const automations: Automation[] = [];
  const rpcCalls: { method: string; input: Record<string, unknown> }[] = [];
  host.harness.inspection.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }: { pluginId: string; method: string; input: Record<string, unknown>; outputSchema: { parse(value: unknown): unknown } }) => {
    if (pluginId !== "automations") throw new Error("Unknown plugin");
    rpcCalls.push({ method, input });
    if (method === "automations_overview") return outputSchema.parse({ automations: automations.map((automation) => ({ automation, project: { id: automation.projectId, name: "P" } })) });
    const found = automations.find((automation) => automation.id === input.automationId);
    if (!found) throw new Error("Automation not found");
    if (method === "automations_get") return outputSchema.parse(found);
    if (method === "automations_update") {
      if (input.agent) { const agent = input.agent as { target: { threadId: string } } & Record<string, unknown>; Object.assign(found.execution, { targetThreadId: agent.target.threadId, ...(agent.model ? { providerId: agent.providerId, model: agent.model } : {}) }); }
      if (input.execution) found.execution = input.execution as Record<string, unknown>;
      return found;
    }
    throw new Error(`Unexpected ${method}`);
  });
  host.harness.inspection.sdk.stub("threads.context", async () => ({ usage: { usedTokens: 1234, estimated: false, modelContextWindow: 200000 } }));
  host.harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "running-model", reasoningLevel: "high", serviceTier: "default", permissionMode: "auto", source: "client/turn/requested" }));
  // A bot with a desk in the work project, two live children and one archived child.
  async function bot(name: string, projectId = "project") {
    const created = await host.create(name);
    const desk = `${name}-desk`;
    host.threads.set(desk, makeThreadResponse({ id: desk, projectId, createdAt: 1 }));
    host.store.bind(desk, created.id);
    for (const child of ["a", "b"]) host.threads.set(`${name}-${child}`, makeThreadResponse({ id: `${name}-${child}`, projectId, parentThreadId: desk, title: `Work ${child}`, createdAt: 2 }));
    host.threads.set(`${name}-old`, makeThreadResponse({ id: `${name}-old`, projectId, parentThreadId: desk, archivedAt: 5, createdAt: 2 }));
    host.threads.set(`${name}-side`, makeThreadResponse({ id: `${name}-side`, projectId, createdAt: 3 }));
    host.store.bind(`${name}-side`, created.id);
    host.store.save({ ...host.store.require(created.id), mainThreadId: desk, threadOrder: [desk, `${name}-side`] });
    return { bot: host.store.require(created.id), desk };
  }
  const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const replace = async (input: Record<string, unknown>) => (await call("desk_replace", input) as { results: Record<string, unknown>[] }).results;
  return { host, automations, rpcCalls, bot, call, replace };
}

describe("desk_replace", () => {
  it("moves live children before archiving, archives the old desk, and pins a titled new desk first", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas, desk } = await bot("Atlas");
    const [result] = await replace({ botIds: [atlas.id], desk: SOL });
    const newDesk = result!.newDeskId as string;
    expect(result).toMatchObject({ botId: atlas.id, oldDeskId: desk, moved: ["Atlas-a", "Atlas-b"] });
    expect(result!.error).toBeUndefined();
    // Children moved before the archive, so the archive cannot take them with it.
    expect(host.events).toEqual(["update:Atlas-a", "update:Atlas-a", "update:Atlas-b", "update:Atlas-b", `archive:${desk}`]);
    expect(host.threads.get(desk)!.archivedAt).not.toBeNull();
    for (const child of ["Atlas-a", "Atlas-b"]) expect(host.threads.get(child)).toMatchObject({ parentThreadId: newDesk, parentNotifications: "stuck", archivedAt: null });
    expect(host.harness.inspection.sdk.callsTo("threads.update").map(call => call[0])).toEqual([
      { threadId: "Atlas-a", parentNotifications: "stuck" },
      { threadId: "Atlas-a", parentThreadId: newDesk },
      { threadId: "Atlas-b", parentNotifications: "stuck" },
      { threadId: "Atlas-b", parentThreadId: newDesk },
    ]);
    expect(host.threads.get("Atlas-old")!.parentThreadId).toBe(desk);
    const saved = host.store.require(atlas.id);
    expect(saved.threadOrder![0]).toBe(newDesk);
    expect(saved.threadOrder).not.toContain(desk);
    expect(saved.mainThreadId).toBe(newDesk);
    expect(host.store.owner(newDesk)).toBe(atlas.id);
    const spawn = host.spawns.at(-1)!;
    expect(spawn).toMatchObject({ projectId: "project", parentNotifications: "stuck", title: "Atlas desk", providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "auto", environment: { type: "host", hostId: "host-home", workspace: { type: "unmanaged", path: null } } });
    const handover = (spawn.input as { text: string }[])[0]!.text;
    expect(handover).toContain(`You replace the previous desk ${desk}`);
    expect(handover).toContain("Atlas-a (Work a");
    expect(handover).not.toContain("Atlas-old");
    expect(host.store.require(atlas.id).settings.desk).toEqual(SOL);
  });

  it("leaves children and the old desk in place when quieting a child fails", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas, desk } = await bot("Atlas");
    host.harness.inspection.sdk.stub("threads.update", async () => { throw new Error("Notification update failed"); });
    const [result] = await replace({ botIds: [atlas.id] });
    expect(result).toMatchObject({ oldDeskId: desk, moved: [], error: "Notification update failed" });
    expect(host.harness.inspection.sdk.callsTo("threads.update").map(call => call[0])).toEqual([
      { threadId: "Atlas-a", parentNotifications: "stuck" },
    ]);
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    for (const id of [desk, "Atlas-a", "Atlas-b"]) expect(host.threads.get(id)!.archivedAt).toBeNull();
    expect(host.threads.get("Atlas-a")!.parentThreadId).toBe(desk);
    expect(host.threads.get("Atlas-b")!.parentThreadId).toBe(desk);
  });

  it("starts a personal desk in the bot's personal workspace", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas } = await bot("Atlas", PERSONAL_ID);
    const [result] = await replace({ botIds: [atlas.id] });
    expect(result!.error).toBeUndefined();
    expect(host.spawns.at(-1)).toMatchObject({ projectId: PERSONAL_ID, environment: { type: "host", hostId: "host-home", workspace: { type: "personal" } } });
  });

  it("applies a dated override until it ends, then falls back to the desk model", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas } = await bot("Atlas");
    await replace({ botIds: [atlas.id], desk: SONNET });
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await replace({ botIds: [atlas.id], desk: SOL, until });
    expect(host.store.require(atlas.id).settings).toMatchObject({ desk: SONNET, deskOverride: { ...SOL, until } });
    expect(host.spawns.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
    // Replacing without a model keeps using the override while it lasts.
    await replace({ botIds: [atlas.id] });
    expect(host.spawns.at(-1)).toMatchObject({ model: "gpt-6.1-sol" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(until) + 1000);
    await replace({ botIds: [atlas.id] });
    expect(host.spawns.at(-1)).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5" });
  });

  it("clears a temporary override when a permanent desk model is chosen", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas } = await bot("Atlas");
    await replace({ botIds: [atlas.id], desk: SOL, until: new Date(Date.now() + 3600_000).toISOString() });
    await replace({ botIds: [atlas.id], desk: SONNET });
    expect(host.store.require(atlas.id).settings).not.toHaveProperty("deskOverride");
    expect(host.spawns.at(-1)).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("saves the model but leaves the desk alone when it is the skipped conversation", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas, desk } = await bot("Atlas");
    const [result] = await replace({ botIds: [atlas.id], desk: SOL, skipThreadId: desk });
    expect(result).toMatchObject({ oldDeskId: desk, newDeskId: null, moved: [] });
    expect(result!.skipped).toBeTruthy();
    expect(host.spawns).toHaveLength(0);
    expect(host.events).toEqual([]);
    expect(host.store.require(atlas.id).settings.desk).toEqual(SOL);
  });

  it("replaces several bots in order, each on its own effective model", async () => {
    const { host, bot, replace, call } = await setup();
    const { bot: atlas, desk: atlasDesk } = await bot("Atlas");
    const { bot: beryl, desk: berylDesk } = await bot("Beryl");
    await call("state_apply", { botId: beryl.id, change: { target: "settings", action: "set", values: { desk: SONNET } } });
    const results = await replace({ botIds: [atlas.id, beryl.id] });
    expect(results.map((result) => [result.botId, result.oldDeskId, result.moved])).toEqual([
      [atlas.id, atlasDesk, ["Atlas-a", "Atlas-b"]],
      [beryl.id, berylDesk, ["Beryl-a", "Beryl-b"]],
    ]);
    // Atlas has no desk setting, so its launch preset (none) leaves project defaults.
    expect(host.spawns[0]).not.toHaveProperty("providerId");
    expect(host.spawns[1]).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5" });
    expect(host.threads.get(atlasDesk)!.archivedAt).not.toBeNull();
    expect(host.threads.get(berylDesk)!.archivedAt).not.toBeNull();
  });

  it("retargets check-ins and watchers that pointed at the old desk", async () => {
    const { bot, replace, automations } = await setup();
    const { bot: atlas, desk } = await bot("Atlas");
    automations.push(
      { id: "a1", projectId: "project", name: "Bot check-in: Atlas #1", execution: { mode: "agent", prompt: "Check in", providerId: "claude-code", model: "claude-sonnet-5-5", targetThreadId: desk } },
      { id: "a2", projectId: "project", name: "Bot watcher: Atlas Disk", execution: { mode: "script", script: "#!/bin/bash\necho hi", interpreter: "bash", timeoutMs: 60000, env: { BOT_DESK_THREAD: desk, OTHER: "x" }, workingDirectory: { type: "automation-storage" }, storedScriptPath: "/s" } },
      { id: "a3", projectId: "project", name: "Unrelated", execution: { mode: "agent", prompt: "x", providerId: "codex", model: "m", targetThreadId: "elsewhere" } },
    );
    const [result] = await replace({ botIds: [atlas.id], desk: SOL });
    const newDesk = result!.newDeskId;
    expect(result!.automationsRetargeted).toEqual(["Bot check-in: Atlas #1", "Bot watcher: Atlas Disk"]);
    expect(automations[0]!.execution).toMatchObject({ targetThreadId: newDesk, providerId: "codex", model: "gpt-6.1-sol" });
    expect(automations[1]!.execution).toEqual({ mode: "script", script: "#!/bin/bash\necho hi", interpreter: "bash", timeoutMs: 60000, env: { BOT_DESK_THREAD: newDesk, OTHER: "x" }, workingDirectory: { type: "automation-storage" } });
    expect(automations[2]!.execution.targetThreadId).toBe("elsewhere");
  });

  it("reports automations it could not retarget instead of failing the replacement", async () => {
    const { host, bot, replace } = await setup();
    const { bot: atlas } = await bot("Atlas");
    host.harness.inspection.sdk.stub("plugins.callRpc", async () => { throw new Error("automations disabled"); });
    const [result] = await replace({ botIds: [atlas.id] });
    expect(result!.error).toBeUndefined();
    expect(result!.newDeskId).toBeTruthy();
    expect((result!.automationsPending as string[])[0]).toContain("automations disabled");
  });

  it("rejects an override without a model, a past end, and unknown bots before changing anything", async () => {
    const { host, bot, call } = await setup();
    const { bot: atlas } = await bot("Atlas");
    await expect(call("desk_replace", { botIds: [atlas.id], until: new Date(Date.now() + 1000).toISOString() })).rejects.toThrow();
    await expect(call("desk_replace", { botIds: [atlas.id], desk: SOL, until: "2001-01-01T00:00:00Z" })).rejects.toThrow();
    await expect(call("desk_replace", { botIds: [atlas.id, "missing"] })).rejects.toThrow();
    expect(host.spawns).toHaveLength(0);
    expect(host.store.require(atlas.id).settings).toEqual({});
  });
});

describe("desk_status", () => {
  it("reports each desk, its running model, context size, live children and saved models", async () => {
    const { bot, call } = await setup();
    const { bot: atlas, desk } = await bot("Atlas");
    await call("state_apply", { botId: atlas.id, change: { target: "settings", action: "set", values: { desk: SONNET, deskOverride: { ...SOL, until: "2999-01-01T00:00:00Z" } } } });
    const { bots } = await call("desk_status", null) as { bots: Record<string, unknown>[] };
    expect(bots).toEqual([expect.objectContaining({
      botId: atlas.id, deskId: desk, model: "running-model", contextTokens: 1234, liveChildren: 2,
      desk: SONNET, deskOverride: { ...SOL, until: "2999-01-01T00:00:00Z" }, effective: SOL, effectiveSource: "override",
    })]);
  });
});

describe("bb bots desk", () => {
  it("replaces named bots with the given model and never the invoking conversation", async () => {
    const { host, bot } = await setup();
    const { bot: atlas, desk } = await bot("Atlas");
    const { bot: beryl } = await bot("Beryl");
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    const result = await run(["desk", "Atlas", beryl.id, "--provider", "codex", "--model", "gpt-6.1-sol", "--reasoning", "high", "--json"], { threadId: desk });
    expect(result.exitCode).toBe(0);
    const { results } = JSON.parse(result.stdout!);
    expect(results[0]).toMatchObject({ botId: atlas.id, skipped: expect.any(String) });
    expect(results[1]).toMatchObject({ botId: beryl.id, moved: ["Beryl-a", "Beryl-b"] });
    expect(host.store.require(atlas.id).settings.desk).toEqual(SOL);
    const status = await run(["desk-status"]);
    expect(status.stdout).toContain("gpt-6.1-sol");
  });

  it("rejects incomplete model flags and mixing --all with names", async () => {
    const { host, bot } = await setup();
    await bot("Atlas");
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    for (const argv of [["desk", "Atlas", "--provider", "codex"], ["desk", "Atlas", "--all"], ["desk"], ["desk", "Atlas", "--until", "2999-01-01T00:00:00Z"], ["desk", "Atlas", "--provider", "codex", "--model", "m", "--reasoning", "high", "--until", "tomorrow"]]) {
      expect((await run(argv)).exitCode).toBe(1);
    }
    expect(host.spawns).toHaveLength(0);
  });
});

describe("effective desk", () => {
  const bot = (settings: BotMetadata["settings"], launch = false) => ({ settings, launchPreset: launch ? { execution: { ...SOL, serviceTier: "fast", permissionMode: null }, workspace: "checkout" as const, initialPrompt: "" } : null });
  it("prefers an active override, then the desk, then the launch preset, then project defaults", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    const override = { ...SOL, until: "2026-10-28T03:00:00Z" };
    expect(effectiveDesk(bot({ desk: SONNET, deskOverride: override }), now)).toEqual({ model: SOL, source: "override" });
    expect(effectiveDesk(bot({ desk: SONNET, deskOverride: override }), Date.parse("2026-10-28T03:00:01Z"))).toEqual({ model: SONNET, source: "desk" });
    expect(effectiveDesk(bot({}, true), now)).toEqual({ model: { ...SOL, serviceTier: "fast" }, source: "launch" });
    expect(effectiveDesk(bot({ desk: { model: "broken" } }), now)).toEqual({ model: null, source: "default" });
  });
  it("turns a request into settings changes", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    expect(deskSettingsChange(undefined, undefined, now)).toBeNull();
    expect(deskSettingsChange(SOL, null, now)).toEqual({ set: { desk: SOL }, unset: ["deskOverride"] });
    expect(deskSettingsChange(SOL, "2026-10-28T03:00:00Z", now)).toEqual({ set: { deskOverride: { ...SOL, until: "2026-10-28T03:00:00Z" } }, unset: [] });
    expect(() => deskSettingsChange(null, "2026-10-28T03:00:00Z", now)).toThrow();
  });
});
