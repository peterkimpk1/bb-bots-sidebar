import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

it("deletes a bot with its bindings and project roles, and leaves its conversations", async () => {
  const host = await backend(); hosts.push(host);
  const doomed = await host.create("Doomed"), kept = await host.create("Kept");
  host.threads.set("chat", makeThreadResponse({ id: "chat", projectId: "project" }));
  host.store.bind("chat", doomed.id); host.store.bind("other", kept.id);
  host.store.changeProjectRole(doomed.id, "project", "own");
  const directory = host.stateDirectory(doomed.id);

  await expect(host.harness.behavior.callRpc("bot_delete", { botId: doomed.id, confirmName: "doomed" })).rejects.toThrow("exact name");
  expect(host.store.get(doomed.id)).toBeTruthy();

  expect(await host.harness.behavior.callRpc("bot_delete", { botId: doomed.id, confirmName: "Doomed" })).toEqual({ ok: true, unboundThreads: 1 });
  expect(host.store.get(doomed.id)).toBeFalsy();
  expect(host.store.owner("chat")).toBeNull();
  expect(host.store.projectOwners().some(o => o.botId === doomed.id)).toBe(false);
  expect(existsSync(directory)).toBe(false);
  expect(host.threads.has("chat")).toBe(true);
  expect(host.store.get(kept.id)).toBeTruthy();
  expect(host.store.owner("other")).toBe(kept.id);
});

it("renders each bot's avatar as static SVG in idle and working states", async () => {
  const host = await backend(); hosts.push(host);
  const bot = await host.create("Atlas");
  const { avatars } = await host.harness.behavior.callRpc("bot_avatar_markup", { size: 26 }) as { avatars: { botId: string; idle: string; working: string }[] };
  const [entry] = avatars;
  expect(entry!.botId).toBe(bot.id);
  expect(entry!.idle).toMatch(/^<svg[^>]*class="bot-avatar bot-motion-\w+ bot-state-idle bot-idle-\d"/);
  expect(entry!.idle).toContain(`data-shape="${bot.avatar.shape}"`);
  expect(entry!.idle).toContain('width="26"');
  expect(entry!.working).toContain("bot-state-working");
});
