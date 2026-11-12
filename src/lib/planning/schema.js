import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import { PLAN_LIMITS } from "./constants.js";

const COMPLEXITIES = new Set(["low", "medium", "high"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

export const PLAN_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "interpretedObjective", "assumptions", "missingInformation", "constraints",
    "affectedModules", "risks", "options", "recommendedOptionIndex",
  ],
  additionalProperties: false,
  properties: {
    interpretedObjective: { type: "string", minLength: 1, maxLength: 8000 },
    assumptions: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
    missingInformation: {
      type: "array", maxItems: 30, items: {
        type: "object", required: ["question", "reason", "required"], additionalProperties: false,
        properties: {
          question: { type: "string", minLength: 1, maxLength: 2000 },
          reason: { type: "string", maxLength: 2000 },
          required: { type: "boolean" },
        },
      },
    },
    constraints: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
    affectedModules: { type: "array", maxItems: 100, items: { type: "string", maxLength: 1000 } },
    risks: {
      type: "array", maxItems: 50, items: {
        type: "object", required: ["severity", "description", "mitigation"], additionalProperties: false,
        properties: {
          severity: { enum: ["low", "medium", "high", "critical"] },
          description: { type: "string", minLength: 1, maxLength: 2000 },
          mitigation: { type: "string", maxLength: 2000 },
        },
      },
    },
    options: {
      type: "array", minItems: 0, maxItems: PLAN_LIMITS.maxOptions, items: {
        type: "object",
        required: [
          "name", "summary", "architecture", "implementationSteps", "filesAffected",
          "pros", "cons", "risks", "complexity", "compatibility", "acceptanceCriteria", "testStrategy",
        ],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          summary: { type: "string", minLength: 1, maxLength: 4000 },
          architecture: { type: "string", minLength: 1, maxLength: 12000 },
          implementationSteps: { type: "array", maxItems: 100, items: { type: "string", maxLength: 3000 } },
          filesAffected: { type: "array", maxItems: 200, items: { type: "string", maxLength: 1000 } },
          pros: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
          cons: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
          risks: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
          complexity: { enum: ["low", "medium", "high"] },
          compatibility: { type: "string", minLength: 1, maxLength: 4000 },
          acceptanceCriteria: { type: "array", maxItems: 100, items: { type: "string", maxLength: 2000 } },
          testStrategy: { type: "array", maxItems: 100, items: { type: "string", maxLength: 2000 } },
        },
      },
    },
    recommendedOptionIndex: { type: ["integer", "null"], minimum: 0 },
  },
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rejectExtraKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function cleanString(value, max, path, errors, { required = false } = {}) {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return "";
  }
  const clean = value.replace(/\u0000/g, "").trim();
  if (required && !clean) errors.push(`${path} is required`);
  if (clean.length > max) errors.push(`${path} exceeds ${max} characters`);
  return redactProjectText(clean.slice(0, max)).text;
}

function cleanStringArray(value, maxItems, maxChars, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length > maxItems) errors.push(`${path} exceeds ${maxItems} items`);
  return value.slice(0, maxItems).map((item, index) => cleanString(item, maxChars, `${path}[${index}]`, errors, { required: true }));
}

export function validatePlanningOutput(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["plan output must be an object"], value: null };
  rejectExtraKeys(input, new Set([
    "interpretedObjective", "assumptions", "missingInformation", "constraints",
    "affectedModules", "risks", "options", "recommendedOptionIndex",
  ]), "plan", errors);

  const value = {
    interpretedObjective: cleanString(input.interpretedObjective, 8000, "interpretedObjective", errors, { required: true }),
    assumptions: cleanStringArray(input.assumptions, 50, 2000, "assumptions", errors),
    missingInformation: [],
    constraints: cleanStringArray(input.constraints, 50, 2000, "constraints", errors),
    affectedModules: cleanStringArray(input.affectedModules, 100, 1000, "affectedModules", errors),
    risks: [],
    options: [],
    recommendedOptionIndex: input.recommendedOptionIndex,
  };

  if (!Array.isArray(input.missingInformation)) errors.push("missingInformation must be an array");
  else {
    if (input.missingInformation.length > 30) errors.push("missingInformation exceeds 30 items");
    value.missingInformation = input.missingInformation.slice(0, 30).map((item, index) => {
      if (!isPlainObject(item)) {
        errors.push(`missingInformation[${index}] must be an object`);
        return { question: "", reason: "", required: true };
      }
      rejectExtraKeys(item, new Set(["question", "reason", "required"]), `missingInformation[${index}]`, errors);
      if (typeof item.required !== "boolean") errors.push(`missingInformation[${index}].required must be boolean`);
      return {
        question: cleanString(item.question, 2000, `missingInformation[${index}].question`, errors, { required: true }),
        reason: cleanString(item.reason, 2000, `missingInformation[${index}].reason`, errors),
        required: item.required === true,
      };
    });
  }

  if (!Array.isArray(input.risks)) errors.push("risks must be an array");
  else {
    if (input.risks.length > 50) errors.push("risks exceeds 50 items");
    value.risks = input.risks.slice(0, 50).map((item, index) => {
      if (!isPlainObject(item)) {
        errors.push(`risks[${index}] must be an object`);
        return { severity: "medium", description: "", mitigation: "" };
      }
      rejectExtraKeys(item, new Set(["severity", "description", "mitigation"]), `risks[${index}]`, errors);
      if (!SEVERITIES.has(item.severity)) errors.push(`risks[${index}].severity is invalid`);
      return {
        severity: SEVERITIES.has(item.severity) ? item.severity : "medium",
        description: cleanString(item.description, 2000, `risks[${index}].description`, errors, { required: true }),
        mitigation: cleanString(item.mitigation, 2000, `risks[${index}].mitigation`, errors),
      };
    });
  }

  if (!Array.isArray(input.options)) errors.push("options must be an array");
  else {
    if (input.options.length > PLAN_LIMITS.maxOptions) errors.push(`options exceeds ${PLAN_LIMITS.maxOptions} items`);
    value.options = input.options.slice(0, PLAN_LIMITS.maxOptions).map((option, index) => {
      if (!isPlainObject(option)) {
        errors.push(`options[${index}] must be an object`);
        return null;
      }
      rejectExtraKeys(option, new Set([
        "name", "summary", "architecture", "implementationSteps", "filesAffected",
        "pros", "cons", "risks", "complexity", "compatibility", "acceptanceCriteria", "testStrategy",
      ]), `options[${index}]`, errors);
      if (!COMPLEXITIES.has(option.complexity)) errors.push(`options[${index}].complexity is invalid`);
      return {
        name: cleanString(option.name, 200, `options[${index}].name`, errors, { required: true }),
        summary: cleanString(option.summary, 4000, `options[${index}].summary`, errors, { required: true }),
        architecture: cleanString(option.architecture, 12000, `options[${index}].architecture`, errors, { required: true }),
        implementationSteps: cleanStringArray(option.implementationSteps, 100, 3000, `options[${index}].implementationSteps`, errors),
        filesAffected: cleanStringArray(option.filesAffected, 200, 1000, `options[${index}].filesAffected`, errors),
        pros: cleanStringArray(option.pros, 50, 2000, `options[${index}].pros`, errors),
        cons: cleanStringArray(option.cons, 50, 2000, `options[${index}].cons`, errors),
        risks: cleanStringArray(option.risks, 50, 2000, `options[${index}].risks`, errors),
        complexity: COMPLEXITIES.has(option.complexity) ? option.complexity : "medium",
        compatibility: cleanString(option.compatibility, 4000, `options[${index}].compatibility`, errors, { required: true }),
        acceptanceCriteria: cleanStringArray(option.acceptanceCriteria, 100, 2000, `options[${index}].acceptanceCriteria`, errors),
        testStrategy: cleanStringArray(option.testStrategy, 100, 2000, `options[${index}].testStrategy`, errors),
      };
    }).filter(Boolean);
  }

  const requiredQuestions = value.missingInformation.filter((item) => item.required);
  if (!value.options.length && !requiredQuestions.length) errors.push("at least one option is required unless clarification is required");
  if (value.recommendedOptionIndex !== null
      && (!Number.isSafeInteger(value.recommendedOptionIndex)
        || value.recommendedOptionIndex < 0
        || value.recommendedOptionIndex >= value.options.length)) {
    errors.push("recommendedOptionIndex must identify an existing option or be null");
  }

  return { ok: errors.length === 0, errors, value: errors.length ? null : value };
}

export function parsePlanningOutput(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, errors: ["provider returned empty output"], value: null };
  if (text.length > PLAN_LIMITS.responseChars) return { ok: false, errors: ["provider output exceeds size limit"], value: null };
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return validatePlanningOutput(JSON.parse(candidate));
  } catch {
    return { ok: false, errors: ["provider output is not valid JSON"], value: null };
  }
}
