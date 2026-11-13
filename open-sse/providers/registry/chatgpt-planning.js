// ChatGPT Web Planning is an OAuth-backed LLM connector that deliberately
// reuses the supported Codex OAuth transport. It is a separate provider ID so
// administrators can assign it only to Planning, without making the existing
// Codex routing choice ambiguous. It does not use cookies, browser scraping,
// session hijacking, or an OpenAI API key.
import codex from "./codex.js";

const chatgptPlanning = {
  ...codex,
  id: "chatgpt-planning",
  priority: 31,
  alias: "chatgpt-planning",
  uiAlias: "chatgpt-planning",
  display: {
    ...codex.display,
    name: "ChatGPT Web Planning",
    icon: "auto_awesome",
    color: "#10A37F",
    website: "https://chatgpt.com",
    deprecated: false,
    deprecationNotice: undefined,
    kindNotice: undefined,
  },
  category: "oauth",
  serviceKinds: ["llm"],
  // Keep the same OAuth contract as the supported Codex login. The account is
  // stored under this provider ID and can be revoked independently.
  oauth: { ...codex.oauth },
};

export default chatgptPlanning;
