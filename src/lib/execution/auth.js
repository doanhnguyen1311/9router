import { createHash, timingSafeEqual } from "node:crypto";
import { cleanWorkerId, executionError } from "./constants.js";

export function workerTokenFromRequest(request) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw executionError("WORKER_AUTH_REQUIRED", "Worker authentication is required", 401);
  return match[1].trim();
}

export function verifyWorkerRequest(request) {
  const configured = process.env.EXECUTION_WORKER_SECRET;
  if (!configured || configured.length < 32) {
    throw executionError("WORKER_AUTH_UNAVAILABLE", "Execution worker authentication is not configured", 503);
  }
  const token = workerTokenFromRequest(request);
  const expected = createHash("sha256").update(configured).digest();
  const received = createHash("sha256").update(token).digest();
  if (!timingSafeEqual(received, expected)) throw executionError("WORKER_AUTH_INVALID", "Worker authentication failed", 401);
  return { workerId: cleanWorkerId(request.headers.get("x-execution-worker-id")) };
}
