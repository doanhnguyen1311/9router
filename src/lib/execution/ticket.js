import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId.js";
import { EXECUTION_LIMITS, executionError } from "./constants.js";

const base64url = (value) => Buffer.from(value).toString("base64url");
const fromBase64url = (value) => Buffer.from(value, "base64url");

async function ticketSecret() {
  const configured = process.env.EXECUTION_TICKET_SECRET;
  if (configured && configured.length >= 32) return configured;
  // The CLI-auth salt mixes in the installation's random 0600 secret. A raw
  // machine identifier alone is stable but not suitable signing material.
  const machineId = await getConsistentMachineId("9r-cli-auth");
  if (!machineId) throw executionError("EXECUTION_TICKET_SECRET_MISSING", "Execution ticket signing secret is unavailable", 503);
  return `local-machine:${machineId}`;
}

export function hashTicket(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export async function signExecutionTicket(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", await ticketSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export async function verifyExecutionTicket(token) {
  if (typeof token !== "string" || token.length < 40 || token.length > EXECUTION_LIMITS.ticketChars) {
    throw executionError("EXECUTION_TICKET_INVALID", "Execution ticket is invalid", 401);
  }
  const [body, signature] = token.split(".");
  if (!body || !signature || token.split(".").length !== 2) throw executionError("EXECUTION_TICKET_INVALID", "Execution ticket is invalid", 401);
  const expected = createHmac("sha256", await ticketSecret()).update(body).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw executionError("EXECUTION_TICKET_INVALID", "Execution ticket signature is invalid", 401);
  }
  let payload;
  try { payload = JSON.parse(fromBase64url(body).toString("utf8")); }
  catch { throw executionError("EXECUTION_TICKET_INVALID", "Execution ticket payload is invalid", 401); }
  if (!payload?.ticketId || !payload.executionId || !payload.planId || !payload.projectId || !payload.workerId || !payload.exp) {
    throw executionError("EXECUTION_TICKET_INVALID", "Execution ticket claims are incomplete", 401);
  }
  if (Number(payload.exp) <= Date.now()) throw executionError("EXECUTION_TICKET_EXPIRED", "Execution ticket has expired", 401);
  return payload;
}

export function randomTicketNonce() {
  return randomBytes(24).toString("base64url");
}
