# 9Router implementation phases

Thư mục này lưu scope, bằng chứng kiểm thử, báo cáo quality gate và checkpoint cho chương trình Planning → Approval → Execution → Verification → Memory Update.

Các phase phải chạy tuần tự:

1. [`phase-0`](./phase-0/README.md) — baseline và repository audit (`PASS`).
2. [`phase-1`](./phase-1/README.md) — planning foundation + automatic inference interception (`PASS`, reopened checkpoint complete).
3. [`phase-2`](./phase-2/README.md) — dashboard và human approval (historical implementation `PASS`; corrected client-action flow is `PENDING`).
4. [`phase-3`](./phase-3/README.md) — Codex execution integration (historical implementation `PASS`; corrected automatic handoff is `PENDING`).
5. [`phase-4`](./phase-4/README.md) — ChatGPT Web MCP connector (`BLOCKED`).

Không mở khóa phase kế tiếp cho đến khi quality gate của phase hiện tại là `PASS`. Kết quả `NOT TESTED` đối với một tiêu chí nghiệm thu bắt buộc khiến gate là `BLOCKED`, không phải `PASS`.

Phase 1 đã được mở lại và PASS cho luồng request tự động mới. Phase 2 và Phase 3 phải được mở lại tuần tự để hoàn thiện action protocol rồi automatic execution handoff; trạng thái PASS lịch sử của hai phase này không được dùng để bỏ qua quality gate mới. Phase 4 đã có implementation checkpoint và toàn bộ automated gate đều sạch, nhưng Quality Gate vẫn `BLOCKED` vì chưa thể ghép nối một phiên ChatGPT Web thật trong môi trường hiện tại để xác minh end-to-end đúng Project. Xem [`phase-report.md`](./phase-4/phase-report.md) và [`quality-gate.md`](./phase-4/quality-gate.md).
