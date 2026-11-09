import crypto from "node:crypto";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getSettings } from "@/lib/localDb.js";
import { PROJECT_PRINCIPAL_LOCAL } from "./config.js";
import { isProjectAdminPrincipal } from "./config.js";

function cookieValue(request, name) {
  const cookie = request?.headers?.get?.("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function opaque(prefix, value) {
  return `${prefix}:${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32)}`;
}

export function principalFromSession(session) {
  if (!session?.authenticated) return null;
  if (session.oidc) {
    const stable = session.oidcSub || session.oidcEmail;
    return stable ? opaque("oidc", stable) : null;
  }
  if (session.saml) {
    const stable = session.samlEmail || session.samlName;
    return stable ? opaque("saml", stable) : null;
  }
  return PROJECT_PRINCIPAL_LOCAL;
}

export function displayNameFromSession(session) {
  return String(
    session?.oidcName || session?.oidcEmail || session?.samlName || session?.samlEmail || "Local administrator",
  ).slice(0, 200);
}

export async function getProjectIdentity(request) {
  const token = cookieValue(request, "auth_token");
  const session = await getDashboardAuthSession(token);
  const principalId = principalFromSession(session);
  if (principalId) {
    return { principalId, displayName: displayNameFromSession(session), authenticated: true, admin: isProjectAdminPrincipal(principalId) };
  }
  const settings = await getSettings();
  if (settings.requireLogin === false) {
    return { principalId: PROJECT_PRINCIPAL_LOCAL, displayName: "Local administrator", authenticated: false, admin: true };
  }
  return null;
}
