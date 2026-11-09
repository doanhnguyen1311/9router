const STATIC_PATTERNS = [
  { name: "pii-email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: "pii-ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "api-token", regex: /\b(?:sk-|gh[pousr]_|AKIA|ASIA)[A-Za-z0-9_-]{16,}\b/g },
];

function isPaymentCard(candidate) {
  const digits = candidate.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) { value *= 2; if (value > 9) value -= 9; }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactProjectText(value) {
  let text = String(value || "").replace(/\u0000/g, "");
  const findings = [];
  for (const pattern of STATIC_PATTERNS) {
    text = text.replace(pattern.regex, () => {
      findings.push(pattern.name);
      return `[REDACTED:${pattern.name}]`;
    });
  }
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (candidate) => {
    if (!isPaymentCard(candidate)) return candidate;
    findings.push("pii-payment-card");
    return "[REDACTED:pii-payment-card]";
  });
  return { text, findings };
}

export const __test__ = { isPaymentCard };
