import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const MAP = ".agents/skills/test-t3-app/references/feature-map.md";
const ROUTES = "apps/web/src/routes";

const mapText = NodeFS.readFileSync(NodePath.join(root, MAP), "utf8");
const named = new Set([...mapText.matchAll(/`([^`\s]+)`/g)].map((match) => match[1]!));

const routePaths = NodeFS.readdirSync(NodePath.join(root, ROUTES))
  .filter((file) => file.endsWith(".tsx"))
  .flatMap((file) => {
    const source = NodeFS.readFileSync(NodePath.join(root, ROUTES, file), "utf8");
    const declared = /createFileRoute\("([^"]+)"\)/.exec(source)?.[1];
    if (declared === undefined) return [];
    const path = declared.replace(/^\/_chat(?=\/|$)/, "").replace(/(.)\/$/, "$1");
    return path === "" ? [] : [path];
  })
  .toSorted();

const commandNames = [
  ...new Set(
    STATIC_KEYBINDING_COMMANDS.map((command) => command.replace(/\.jump\.\d+$/, ".jump.<n>")),
  ),
  "script.<id>.run",
].toSorted();
const commandNamespaces = new Set(commandNames.map((command) => command.split(".")[0]!));

const looksLikeRoute = (token: string) =>
  /^\/([a-z$][a-z0-9$-]*(\/[a-z$][a-z0-9$-]*)*)?$/.test(token);
const looksLikeCommand = (token: string) =>
  /^[a-z][A-Za-z]*\.[A-Za-z0-9.<>]+$/.test(token) &&
  commandNamespaces.has(token.split(".")[0]!) &&
  !/\.(md|ts|tsx|json)$/.test(token);

it("finds the routes and keybinding commands it checks", () => {
  expect(routePaths).toContain("/settings/general");
  expect(routePaths).toContain("/$environmentId/$threadId");
  expect(commandNames).toContain("diff.toggle");
});

it("names every web route on the feature map", () => {
  expect(
    routePaths.filter((path) => !named.has(path)),
    `add these routes to ${MAP}`,
  ).toEqual([]);
});

it("names every keybinding command on the feature map", () => {
  expect(
    commandNames.filter((command) => !named.has(command)),
    `add these keybinding commands to ${MAP}`,
  ).toEqual([]);
});

it("names no route or keybinding command that no longer exists", () => {
  const routes = new Set(routePaths);
  const commands = new Set(commandNames);
  const stale = [...named].filter(
    (token) =>
      (looksLikeRoute(token) && !routes.has(token)) ||
      (looksLikeCommand(token) && !commands.has(token)),
  );
  expect(stale, `remove or rename these on ${MAP}`).toEqual([]);
});
