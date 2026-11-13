# 9Router implementation phases

Thư mục này lưu scope, bằng chứng kiểm thử, báo cáo quality gate và checkpoint cho chương trình Planning → Approval → Execution → Verification → Memory Update.

Các phase phải chạy tuần tự:

1. [`phase-0`](./phase-0/README.md) — baseline và repository audit (`PASS`).
2. [`phase-1`](./phase-1/README.md) — planning foundation + automatic inference interception (`PASS`, reopened checkpoint complete).
3. [`phase-2`](./phase-2/README.md) — dashboard, API-Key action protocol và human approval (`PASS`, reopened checkpoint complete).
4. [`phase-3`](./phase-3/README.md) — Codex execution integration (`PASS`, corrected automatic handoff checkpoint complete).
5. [`phase-4`](./phase-4/README.md) — ChatGPT Web MCP connector (`BLOCKED`).

Không mở khóa phase kế tiếp cho đến khi quality gate của phase hiện tại là `PASS`. Kết quả `NOT TESTED` đối với một tiêu chí nghiệm thu bắt buộc khiến gate là `BLOCKED`, không phải `PASS`.

Phase 1, Phase 2 và Phase 3 đã được mở lại và PASS cho luồng request tự động → chọn/revise/approve → local Codex execution. Phase 4 đã có implementation checkpoint và toàn bộ automated gate đều sạch, nhưng Quality Gate vẫn `BLOCKED` vì chưa thể ghép nối một phiên ChatGPT Web thật trong môi trường hiện tại để xác minh end-to-end đúng Project. Xem [`phase-report.md`](./phase-4/phase-report.md) và [`quality-gate.md`](./phase-4/quality-gate.md).

Các hardening bổ sung sau checkpoint: cấu hình Planning Provider/Model/Failure
Policy vẫn chỉ thuộc Admin; Admin có thể cấp riêng quyền để API Key owner bật/tắt
Planning hoặc đổi mode. Provider `chatgpt-planning` được thêm như OAuth LLM
provider riêng, dùng Codex OAuth/Responses được hỗ trợ. Xem
[`phase-2/api-key-planning-admin-policy.md`](./phase-2/api-key-planning-admin-policy.md)
và [`phase-4/chatgpt-web-oauth-provider.md`](./phase-4/chatgpt-web-oauth-provider.md).
