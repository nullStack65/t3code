import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { CLAUDE_EFFORT_LEVELS } from "./ClaudeModelCatalog.ts";

// `magpie_label` is what marks a Magpie catalog; plain Anthropic-compatible gateways omit it.
const MagpieGatewayModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optional(Schema.String),
  owned_by: Schema.optional(Schema.String),
  magpie_label: Schema.String,
  supported_reasoning_levels: Schema.optional(
    Schema.Array(Schema.Struct({ effort: Schema.String })),
  ),
});
export type MagpieGatewayModel = typeof MagpieGatewayModel.Type;

const decodeCatalog = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
);
const decodeModel = Schema.decodeUnknownOption(MagpieGatewayModel);

/** The models a Magpie gateway serves, or undefined when the endpoint is not Magpie. */
export function parseMagpieGatewayCatalog(
  json: unknown,
): ReadonlyArray<MagpieGatewayModel> | undefined {
  const catalog = Option.getOrUndefined(decodeCatalog(json));
  const models = (catalog?.data ?? []).flatMap((entry) =>
    Option.toArray(decodeModel(entry)).filter((model) => model.id.trim().length > 0),
  );
  return models.length > 0 ? models : undefined;
}

/** Reads the catalog the way Claude Code's gateway discovery does; any failure means "not Magpie". */
export const fetchMagpieGatewayCatalog = Effect.fn("fetchMagpieGatewayCatalog")(function* (
  baseUrl: string,
  environment: NodeJS.ProcessEnv,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const token = environment.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  return yield* httpClient
    .execute(
      HttpClientRequest.get(`${baseUrl.trim().replace(/\/+$/, "")}/v1/models?limit=1000`).pipe(
        HttpClientRequest.setHeaders({
          "anthropic-version": "2023-06-01",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        }),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map(parseMagpieGatewayCatalog),
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => undefined),
    );
});

type MagpieRoute = "claude" | "codex" | "magpie-go" | "group" | "other";
const ROUTE_ORDER: ReadonlyArray<MagpieRoute> = ["claude", "codex", "magpie-go", "group", "other"];

function magpieRoute(model: MagpieGatewayModel): MagpieRoute {
  const prefix = model.id.split("/", 1)[0];
  return prefix === "claude" || prefix === "codex" || prefix === "magpie-go" || prefix === "group"
    ? prefix
    : "other";
}

// Claude Code runs model names it does not recognise with a 200K window, whatever the model's own.
const UNRECOGNISED_MODEL_LIMIT = "200K context";

function magpieRouteLabel(model: MagpieGatewayModel, route: MagpieRoute): string {
  const raw = model.magpie_label.split(" · ").at(-1)?.trim() || model.owned_by?.trim() || route;
  const label = raw.charAt(0).toUpperCase() + raw.slice(1);
  return route === "claude" ? label : `${label} · ${UNRECOGNISED_MODEL_LIMIT}`;
}

/** Comparable Claude id: no `claude/` route, `[1m]` window or release date. */
function claudeModelKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^claude\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

const CLAUDE_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function magpieServerModel(model: MagpieGatewayModel, route: MagpieRoute): ServerProviderModel {
  // Claude Code sends only its own effort levels, so a gateway level such as `none` is unreachable.
  const efforts = (model.supported_reasoning_levels ?? []).flatMap(({ effort }) =>
    (CLAUDE_EFFORT_LEVELS as ReadonlyArray<string>).includes(effort) ? [effort] : [],
  );
  return {
    slug: model.id,
    name: model.display_name?.trim() || model.id,
    subProvider: magpieRouteLabel(model, route),
    isCustom: false,
    capabilities: {
      optionDescriptors: efforts.length
        ? [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              // `default` sends no effort, so Claude Code picks one.
              options: [
                { id: "default", label: "Default", isDefault: true },
                ...efforts.map((id) => ({ id, label: CLAUDE_EFFORT_LABELS[id] ?? id })),
              ],
            },
          ]
        : [],
    },
  };
}

/**
 * The Claude models the gateway serves keep their built-in entries and options; every other
 * gateway model is added after them, grouped by route. Custom models stay last.
 */
export function withMagpieGatewayModels(
  models: ReadonlyArray<ServerProviderModel>,
  gateway: ReadonlyArray<MagpieGatewayModel>,
): ReadonlyArray<ServerProviderModel> {
  const servedClaude = new Set(
    gateway.filter((model) => magpieRoute(model) === "claude").map((m) => claudeModelKey(m.id)),
  );
  const modelKeys = (model: ServerProviderModel) =>
    [model.slug, ...(model.aliases ?? [])].map(claudeModelKey);
  const builtIn = models.filter(
    (model) => !model.isCustom && modelKeys(model).some((key) => servedClaude.has(key)),
  );
  const custom = models.filter((model) => model.isCustom);
  const coveredClaude = new Set(builtIn.flatMap(modelKeys));
  const takenSlugs = new Set([...builtIn, ...custom].map((model) => model.slug));
  const added = ROUTE_ORDER.flatMap((route) =>
    gateway.flatMap((model) => {
      if (magpieRoute(model) !== route || takenSlugs.has(model.id)) return [];
      if (route === "claude") {
        const key = claudeModelKey(model.id);
        if (coveredClaude.has(key)) return [];
        coveredClaude.add(key);
      }
      takenSlugs.add(model.id);
      return [magpieServerModel(model, route)];
    }),
  );
  return [...builtIn, ...added, ...custom];
}
