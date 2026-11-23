import { describe, expect, it } from "vitest";
import photonAdsPlugin, {
  ADS_RULES,
  ADS_STANDARDS,
  type AdsIgnoreEntry,
  type AdsRuleConfig,
  type AdsRuleOptions,
  createPhotonAdsPlugin,
  getRecommendedRulesConfig,
  getRuleById,
  getStandardByNumber,
  PLUGIN_ID,
} from "./index.js";

describe("photon-ads Redocly plugin exports", () => {
  it("exports plugin metadata, catalog helpers, ignore types, and Redocly plugin factory", () => {
    expect(PLUGIN_ID).toBe("photon-ads");
    expect(ADS_STANDARDS).toHaveLength(3);
    expect(ADS_RULES).toHaveLength(8);

    expect(getStandardByNumber("0001")?.folder).toBe("0001-resource-identifiers");
    expect(getStandardByNumber("0002")?.folder).toBe("0002-top-level-json-response");
    expect(getStandardByNumber("0003")?.folder).toBe("0003-idempotency-key");
    expect(getStandardByNumber("9999")).toBeUndefined();

    expect(getRuleById("photon-ads/ads-0001-resource-primary-id")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0002-top-level-json-object")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0002-no-single-resource-wrapper")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0002-flat-creation-secret")?.severity).toBe("error");
    expect(getRuleById("photon-ads/does-not-exist")).toBeUndefined();

    const recommended = getRecommendedRulesConfig();
    expect(recommended).toEqual({
      "photon-ads/ads-0001-resource-primary-id": "error",
      "photon-ads/ads-0001-path-param-naming": "error",
      "photon-ads/ads-0001-path-param-consistency": "error",
      "photon-ads/ads-0002-top-level-json-object": "error",
      "photon-ads/ads-0002-no-single-resource-wrapper": "error",
      "photon-ads/ads-0002-flat-creation-secret": "error",
      "photon-ads/ads-0003-idempotency-key-method": "error",
      "photon-ads/ads-0003-idempotency-key-optional": "error",
    });

    const ignoreEntry: AdsIgnoreEntry = {
      path: "/v1/projects/{projectId}",
      method: "get",
      schema: "LegacyProject",
      reason: "Legacy response shape",
    };
    const ruleOptions: AdsRuleOptions = { ignore: [ignoreEntry] };
    const ruleConfig: AdsRuleConfig = { severity: "error", ...ruleOptions };
    expect(ruleConfig).toEqual({
      severity: "error",
      ignore: [ignoreEntry],
    });

    const fromDefault = photonAdsPlugin();
    const fromFactory = createPhotonAdsPlugin();
    expect(fromDefault.id).toBe("photon-ads");
    expect(fromFactory.id).toBe("photon-ads");
    expect(fromDefault.configs?.recommended?.rules).toEqual(recommended);
    expect(Object.keys(fromDefault.rules.oas3).sort()).toEqual([
      "ads-0001-path-param-consistency",
      "ads-0001-path-param-naming",
      "ads-0001-resource-primary-id",
      "ads-0002-flat-creation-secret",
      "ads-0002-no-single-resource-wrapper",
      "ads-0002-top-level-json-object",
      "ads-0003-idempotency-key-method",
      "ads-0003-idempotency-key-optional",
    ]);
  });
});
