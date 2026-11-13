# ChatGPT Web Planning OAuth provider

`chatgpt-planning` is a separate OAuth LLM provider. It reuses the supported
Codex OAuth authorization-code/PKCE contract and Codex Responses transport,
but stores connections under its own provider ID so an administrator can assign
it specifically to Planning.

This connector does not use ChatGPT cookies, session extraction, CAPTCHA
bypass, browser scraping, or an OpenAI API key. The existing `chatgpt-web`
cookie/image provider remains unchanged for backward compatibility. A real
ChatGPT account must still be connected in Dashboard → Providers before this
Planning provider can make an upstream request.
