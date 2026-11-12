# 9Router implementation phases

Thư mục này lưu scope, bằng chứng kiểm thử, báo cáo quality gate và checkpoint cho chương trình Planning → Approval → Execution → Verification → Memory Update.

Các phase phải chạy tuần tự:

1. [`phase-0`](./phase-0/README.md) — baseline và repository audit (`PASS`).
2. [`phase-1`](./phase-1/README.md) — planning foundation (`PASS`).
3. [`phase-2`](./phase-2/README.md) — dashboard và human approval (`READY`).
4. [`phase-3`](./phase-3/README.md) — Codex execution integration (`LOCKED`).
5. [`phase-4`](./phase-4/README.md) — ChatGPT Web MCP connector (`LOCKED`).

Không mở khóa phase kế tiếp cho đến khi quality gate của phase hiện tại là `PASS`. Kết quả `NOT TESTED` đối với một tiêu chí nghiệm thu bắt buộc khiến gate là `BLOCKED`, không phải `PASS`.

Phase 0 và Phase 1 đã PASS đầy đủ. Planning backend đã chạy qua production router với upstream cục bộ, có persistence/RBAC/concurrency/audit và full regression sạch. Xem [`phase-report.md`](./phase-1/phase-report.md) và [`quality-gate.md`](./phase-1/quality-gate.md).
