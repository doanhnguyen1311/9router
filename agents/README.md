# 9Router implementation phases

Thư mục này lưu scope, bằng chứng kiểm thử, báo cáo quality gate và checkpoint cho chương trình Planning → Approval → Execution → Verification → Memory Update.

Các phase phải chạy tuần tự:

1. [`phase-0`](./phase-0/README.md) — baseline và repository audit (`PASS`).
2. [`phase-1`](./phase-1/README.md) — planning foundation (`PASS`).
3. [`phase-2`](./phase-2/README.md) — dashboard và human approval (`PASS`).
4. [`phase-3`](./phase-3/README.md) — Codex execution integration (`READY`).
5. [`phase-4`](./phase-4/README.md) — ChatGPT Web MCP connector (`LOCKED`).

Không mở khóa phase kế tiếp cho đến khi quality gate của phase hiện tại là `PASS`. Kết quả `NOT TESTED` đối với một tiêu chí nghiệm thu bắt buộc khiến gate là `BLOCKED`, không phải `PASS`.

Phase 0, Phase 1 và Phase 2 đã PASS đầy đủ. Planning backend và dashboard approval đã chạy qua persistence/RBAC/concurrency/audit với full regression sạch; Codex execution chưa được mở trong Phase 2. Xem [`phase-report.md`](./phase-2/phase-report.md) và [`quality-gate.md`](./phase-2/quality-gate.md).
