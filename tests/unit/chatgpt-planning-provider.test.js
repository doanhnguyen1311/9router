import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { PROVIDERS as OAUTH_PROVIDERS } from "../../src/lib/oauth/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";

describe("ChatGPT Web Planning OAuth provider", () => {
  it("is a separate OAuth LLM provider backed by the supported Codex transport", () => {
    const entry = REGISTRY.find((provider) => provider.id === "chatgpt-planning");
    expect(entry).toMatchObject({ id: "chatgpt-planning", category: "oauth", serviceKinds: ["llm"] });
    expect(entry.authType).not.toBe("cookie");
    expect(entry.oauth).toMatchObject({ authorizeUrl: "https://auth.openai.com/oauth/authorize" });
    expect(PROVIDERS["chatgpt-planning"]).toMatchObject({ format: "openai-responses" });
    expect(PROVIDER_MODELS["chatgpt-planning"]?.length).toBeGreaterThan(0);
    expect(PROVIDER_OAUTH["chatgpt-planning"]).toBeTruthy();
    expect(OAUTH_PROVIDERS["chatgpt-planning"]?.config).toMatchObject({ authorizeUrl: entry.oauth.authorizeUrl, clientId: entry.oauth.clientId });
    expect(getExecutor("chatgpt-planning").getProvider()).toBe("chatgpt-planning");
  });
});
