import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotIcon } from "../components/bot-icon";
import type { BotMetadata } from "../contract";

// Static SVG of the sidebar avatar, for clients that can't load this plugin's
// components (another plugin's sidebar). Classes match the in-plugin avatar,
// so the client's CSS animates the idle and working states.
export function avatarMarkup(bot: Pick<BotMetadata, "avatar" | "order">, size: number) {
  const render = (working: boolean) => renderToStaticMarkup(createElement(BotIcon, { avatar: bot.avatar, size, working, idleVariant: bot.order % 3 }));
  return { idle: render(false), working: render(true) };
}
