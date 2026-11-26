import { ADS_0001_METADATA, PLUGIN_ID } from "../ads/0001-resource-identifiers/rules.js";
import { ADS_0002_METADATA } from "../ads/0002-top-level-json-response/rules.js";
import { ADS_0004_METADATA } from "../ads/0004-long-running-operations/rules.js";
import { ADS_0005_METADATA } from "../ads/0005-standard-resource-methods/rules.js";
import type { AdsRuleMetadata, AdsRuleSeverity, AdsStandardMetadata } from "./types.js";

export { PLUGIN_ID };

export const ADS_STANDARDS: readonly AdsStandardMetadata[] = [
  ADS_0001_METADATA,
  ADS_0002_METADATA,
  ADS_0004_METADATA,
  ADS_0005_METADATA,
];

export const ADS_RULES: readonly AdsRuleMetadata[] = ADS_STANDARDS.flatMap(
  (standard) => standard.rules,
);

export function getStandardByNumber(ads: string): AdsStandardMetadata | undefined {
  return ADS_STANDARDS.find((standard) => standard.ads === ads);
}

export function getRuleById(ruleId: string): AdsRuleMetadata | undefined {
  return ADS_RULES.find((rule) => rule.id === ruleId);
}

export function getRecommendedRulesConfig(): Record<string, AdsRuleSeverity> {
  const config: Record<string, AdsRuleSeverity> = {};
  for (const rule of ADS_RULES) {
    config[rule.id] = rule.severity;
  }
  return config;
}
