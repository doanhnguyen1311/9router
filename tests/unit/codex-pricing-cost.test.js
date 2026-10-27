import { describe, expect, it, vi } from "vitest";

import {
  calculateCodexCostFromTokens,
  calculateCostFromTokens,
  calculateProviderCostFromTokens,
  getPricingForModel,
} from "../../open-sse/providers/pricing.js";
import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { canonicalizeUsage, extractUsage } from "../../open-sse/utils/usageTracking.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(),
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: {},
  formatSSE: vi.fn(),
}));

describe("Codex API-equivalent cost accounting", () => {
  it("uses official Standard prices without changing canonical prices for other providers", () => {
    expect(getPricingForModel("codex", "gpt-5.6-sol")).toMatchObject({
      input: 4,
      cached: 0.4,
      cache_creation: 5,
      output: 20,
    });
    expect(getPricingForModel("codex", "gpt-5.6-terra")).toMatchObject({
      input: 2,
      cached: 0.2,
      cache_creation: 2.5,
      output: 12,
    });
    expect(getPricingForModel("codex", "gpt-5.6-luna")).toMatchObject({
      input: 0.2,
      cached: 0.02,
      cache_creation: 0.25,
      output: 1.2,
    });

    // The existing provider-agnostic price remains untouched.
    expect(getPricingForModel("openai", "gpt-5.6-sol")).toMatchObject({ input: 5, output: 30 });
  });

  it("maps Codex virtual selectors to their underlying API-priced model", () => {
    const base = getPricingForModel("codex", "gpt-5.6-sol");
    expect(getPricingForModel("codex", "gpt-5.6-sol[1m](xhigh)")).toEqual(base);
    expect(getPricingForModel("cx", "gpt-5.6-sol[1m](xhigh)")).toEqual(base);
    expect(getPricingForModel("codex", "gpt-5.6-sol-review")).toEqual(base);
    expect(getPricingForModel("codex", "gpt-daybreak-blue-latest")).toEqual(base);
  });

  it("does not bill reasoning twice because OpenAI output_tokens already includes it", () => {
    const pricing = getPricingForModel("codex", "gpt-6.1-sol");
    const tokens = {
      prompt_tokens: 1_000,
      cached_tokens: 200,
      completion_tokens: 300,
      reasoning_tokens: 100,
    };

    const cost = calculateCodexCostFromTokens("gpt-6.1-sol", tokens, pricing);
    const expected = ((800 * 2) + (200 * 0.1) + (300 * 10)) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("prices 30m and 12h cache writes as input-token subsets", () => {
    const pricing = getPricingForModel("codex", "gpt-6.1-sol");
    const cost = calculateCodexCostFromTokens("gpt-6.1-sol", {
      prompt_tokens: 12_000,
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_30m_tokens: 3_000,
      cache_write_12h_tokens: 4_000,
      completion_tokens: 900,
    }, pricing);
    const expected = (
      (1_000 * 2) +
      (4_000 * 0.1) +
      (3_000 * 2.5) +
      (4_000 * 5) +
      (900 * 10)
    ) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("applies OpenAI long-context multipliers above 272K input tokens", () => {
    const pricing = getPricingForModel("codex", "gpt-6.1-sol");
    const cost = calculateCodexCostFromTokens("gpt-6.1-sol[1m]", {
      prompt_tokens: 300_000,
      cached_tokens: 100_000,
      completion_tokens: 10_000,
    }, pricing);
    const expected = (
      (200_000 * 2 * 2) +
      (100_000 * 0.1 * 2) +
      (10_000 * 10 * 1.5)
    ) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("leaves every non-Codex provider on the existing generic formula", () => {
    const pricing = { input: 2, cached: 0.2, output: 10, reasoning: 12 };
    const tokens = {
      prompt_tokens: 1_000,
      completion_tokens: 300,
      reasoning_tokens: 100,
    };
    expect(calculateProviderCostFromTokens("openai", "gpt-test", tokens, pricing))
      .toBe(calculateCostFromTokens(tokens, pricing));
  });

  it("preserves OpenAI cache-write usage through extraction and canonicalization", () => {
    const extracted = extractUsage({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 12_000,
          input_tokens_details: {
            cached_tokens: 4_000,
            cache_write_tokens: 7_000,
            cache_write_tokens_details: {
              ttl_30m_tokens: 3_000,
              ttl_12h_tokens: 4_000,
            },
          },
          output_tokens: 900,
          output_tokens_details: { reasoning_tokens: 200 },
        },
      },
    });
    const canonical = canonicalizeUsage(extracted);

    expect(canonical).toMatchObject({
      prompt_tokens: 12_000,
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_30m_tokens: 3_000,
      cache_write_12h_tokens: 4_000,
      completion_tokens: 900,
      reasoning_tokens: 200,
    });
  });

  it("preserves the same cache-write details on non-streaming Responses", () => {
    const extracted = extractUsageFromResponse({
      usage: {
        input_tokens: 12_000,
        input_tokens_details: {
          cached_tokens: 4_000,
          cache_write_tokens: 7_000,
          cache_write_tokens_details: {
            ttl_30m_tokens: 3_000,
            ttl_12h_tokens: 4_000,
          },
        },
        output_tokens: 900,
        output_tokens_details: { reasoning_tokens: 200 },
      },
    });

    expect(extracted).toMatchObject({
      prompt_tokens: 12_000,
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_30m_tokens: 3_000,
      cache_write_12h_tokens: 4_000,
      completion_tokens: 900,
    });
  });
});
