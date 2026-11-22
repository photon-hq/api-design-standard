import { ads0001Rules } from "../ads/0001-resource-identifiers/rules.js";
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
      },
    },
  };
}

export default function photonAdsPlugin(): RedoclyPlugin {
  return createPhotonAdsPlugin();
}
