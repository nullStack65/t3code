import * as NodeServices from "@effect/platform-node/NodeServices";
import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const MAP = ".agents/skills/test-t3-app/references/feature-map.md";
const ROUTES = "apps/web/src/routes";

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

const loadMap = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const mapText = yield* fs.readFileString(path.join(root, MAP));
  const named = new Set([...mapText.matchAll(/`([^`\s]+)`/g)].map((match) => match[1]!));
  const files = (yield* fs.readDirectory(path.join(root, ROUTES))).filter((file) =>
    file.endsWith(".tsx"),
  );
  const routePaths: string[] = [];
  for (const file of files) {
    const source = yield* fs.readFileString(path.join(root, ROUTES, file));
    const declared = /createFileRoute\("([^"]+)"\)/.exec(source)?.[1];
    if (declared === undefined) continue;
    const route = declared.replace(/^\/_chat(?=\/|$)/, "").replace(/(.)\/$/, "$1");
    if (route !== "") routePaths.push(route);
  }
  return { named, routePaths: routePaths.toSorted() };
});

it.layer(NodeServices.layer)("feature map", (it) => {
  it.effect("finds the routes and keybinding commands it checks", () =>
    Effect.gen(function* () {
      const { routePaths } = yield* loadMap;
      expect(routePaths).toContain("/settings/general");
      expect(routePaths).toContain("/$environmentId/$threadId");
      expect(commandNames).toContain("diff.toggle");
    }),
  );

  it.effect("names every web route on the feature map", () =>
    Effect.gen(function* () {
      const { named, routePaths } = yield* loadMap;
      expect(
        routePaths.filter((route) => !named.has(route)),
        `add these routes to ${MAP}`,
      ).toEqual([]);
    }),
  );

  it.effect("names every keybinding command on the feature map", () =>
    Effect.gen(function* () {
      const { named } = yield* loadMap;
      expect(
        commandNames.filter((command) => !named.has(command)),
        `add these keybinding commands to ${MAP}`,
      ).toEqual([]);
    }),
  );

  it.effect("names no route or keybinding command that no longer exists", () =>
    Effect.gen(function* () {
      const { named, routePaths } = yield* loadMap;
      const routes = new Set(routePaths);
      const commands = new Set(commandNames);
      const stale = [...named].filter(
        (token) =>
          (looksLikeRoute(token) && !routes.has(token)) ||
          (looksLikeCommand(token) && !commands.has(token)),
      );
      expect(stale, `remove or rename these on ${MAP}`).toEqual([]);
    }),
  );
});
