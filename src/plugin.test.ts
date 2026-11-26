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
    expect(ADS_STANDARDS).toHaveLength(4);
    expect(ADS_RULES).toHaveLength(14);

    expect(getStandardByNumber("0001")?.folder).toBe("0001-resource-identifiers");
    expect(getStandardByNumber("0002")?.folder).toBe("0002-top-level-json-response");
    expect(getStandardByNumber("0004")?.folder).toBe("0004-long-running-operations");
    expect(getStandardByNumber("0005")?.folder).toBe("0005-standard-resource-methods");
    expect(getStandardByNumber("9999")).toBeUndefined();

    expect(getRuleById("photon-ads/ads-0001-resource-primary-id")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0002-top-level-json-object")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0002-no-single-resource-wrapper")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0002-flat-creation-secret")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0004-operation-resource-shape")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0004-operation-status-invariants")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0004-accepted-operation-headers")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0004-operation-cancel-method")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0005-addressable-resource-read")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0005-standard-http-methods")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0005-standard-status-codes")?.severity).toBe("error");
    expect(getRuleById("photon-ads/ads-0005-url-path-naming")?.severity).toBe("error");
    expect(getRuleById("photon-ads/does-not-exist")).toBeUndefined();

    const recommended = getRecommendedRulesConfig();
    expect(recommended).toEqual({
      "photon-ads/ads-0001-resource-primary-id": "error",
      "photon-ads/ads-0001-path-param-naming": "error",
      "photon-ads/ads-0001-path-param-consistency": "error",
      "photon-ads/ads-0002-top-level-json-object": "error",
      "photon-ads/ads-0002-no-single-resource-wrapper": "error",
      "photon-ads/ads-0002-flat-creation-secret": "error",
      "photon-ads/ads-0004-operation-resource-shape": "error",
      "photon-ads/ads-0004-operation-status-invariants": "error",
      "photon-ads/ads-0004-accepted-operation-headers": "error",
      "photon-ads/ads-0004-operation-cancel-method": "error",
      "photon-ads/ads-0005-addressable-resource-read": "error",
      "photon-ads/ads-0005-standard-http-methods": "error",
      "photon-ads/ads-0005-standard-status-codes": "error",
      "photon-ads/ads-0005-url-path-naming": "error",
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
      "ads-0004-accepted-operation-headers",
      "ads-0004-operation-cancel-method",
      "ads-0004-operation-resource-shape",
      "ads-0004-operation-status-invariants",
      "ads-0005-addressable-resource-read",
      "ads-0005-standard-http-methods",
      "ads-0005-standard-status-codes",
      "ads-0005-url-path-naming",
    ]);
  });
});
