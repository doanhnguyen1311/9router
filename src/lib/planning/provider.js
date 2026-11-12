import { planningError } from "./constants.js";

export class PlanningProvider {
  constructor(id) {
    if (!id) throw planningError("PLANNING_PROVIDER_INVALID", "Planning provider ID is required");
    this.id = id;
  }

  async validateCapabilities() {
    throw new Error("validateCapabilities() must be implemented");
  }

  async healthCheck() {
    throw new Error("healthCheck() must be implemented");
  }

  async generatePlan() {
    throw new Error("generatePlan() must be implemented");
  }

  async revisePlan() {
    throw new Error("revisePlan() must be implemented");
  }
}

export class PlanningProviderError extends Error {
  constructor(code, message, { status = 502, retryable = false, cause = undefined } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PlanningProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
