import { ads0001Rules } from "../ads/0001-resource-identifiers/rules.js";
import { ads0002Rules } from "../ads/0002-top-level-json-response/rules.js";
import { ads0003Rules } from "../ads/0003-idempotency-key/rules.js";
import { ads0004Rules } from "../ads/0004-long-running-operations/rules.js";
import { ads0005Rules } from "../ads/0005-standard-resource-methods/rules.js";
import { ads0006Rules } from "../ads/0006-list-pagination/rules.js";
import { getRecommendedRulesConfig, PLUGIN_ID } from "./catalog.js";
import type { RedoclyPlugin } from "./types.js";

export function createPhotonAdsPlugin(): RedoclyPlugin {
  return {
    id: PLUGIN_ID,
    configs: {
      recommended: {
        rules: getRecommendedRulesConfig(),
      },
    },
    rules: {
      oas3: {
        ...ads0001Rules,
        ...ads0002Rules,
        ...ads0003Rules,
        ...ads0004Rules,
        ...ads0005Rules,
        ...ads0006Rules,
      },
    },
  };
}

export default function photonAdsPlugin(): RedoclyPlugin {
  return createPhotonAdsPlugin();
}
