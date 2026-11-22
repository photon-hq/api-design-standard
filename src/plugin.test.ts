import { describe, expect, it } from "vitest";
import photonAdsPlugin, {
  ADS_RULES,
  ADS_STANDARDS,
  createPhotonAdsPlugin,
  getRecommendedRulesConfig,
  getRuleById,
  getStandardByNumber,
  PLUGIN_ID,
} from "./index.js";

describe("photon-ads Redocly plugin exports", () => {
  it("exports plugin metadata, catalog helpers, and Redocly plugin factory", () => {
    expect(PLUGIN_ID).toBe("photon-ads");
    expect(ADS_STANDARDS).toHaveLength(1);
    expect(ADS_RULES).toHaveLength(3);

    expect(getStandardByNumber("0001")?.folder).toBe("0001-resource-identifiers");
    expect(getStandardByNumber("9999")).toBeUndefined();

    expect(getRuleById("photon-ads/ads-0001-resource-primary-id")?.severity).toBe("error");
    expect(getRuleById("photon-ads/does-not-exist")).toBeUndefined();

    const recommended = getRecommendedRulesConfig();
    expect(recommended).toEqual({
      "photon-ads/ads-0001-resource-primary-id": "error",
      "photon-ads/ads-0001-path-param-naming": "error",
      "photon-ads/ads-0001-path-param-consistency": "error",
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
    ]);
  });
});
