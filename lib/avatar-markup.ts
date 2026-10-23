import * as ReactRuntime from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotIcon } from "../components/bot-icon";
import type { BotMetadata } from "../contract";

// bb's server bundle compiles JSX in classic mode (React.createElement) despite
// tsconfig's react-jsx, so the avatar component needs React in scope here. The
// app bundle and the tests use the automatic runtime and never read this.
(globalThis as { React?: typeof ReactRuntime }).React ??= ReactRuntime;

// Static SVG of the sidebar avatar, for clients that can't load this plugin's
// components (another plugin's sidebar). Classes match the in-plugin avatar,
// so the client's CSS animates the idle and working states.
export function avatarMarkup(bot: Pick<BotMetadata, "avatar" | "order">, size: number) {
  const render = (working: boolean) => renderToStaticMarkup(createElement(BotIcon, { avatar: bot.avatar, size, working, idleVariant: bot.order % 3 }));
  return { idle: render(false), working: render(true) };
}
