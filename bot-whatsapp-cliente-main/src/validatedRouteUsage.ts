import type { RouteDispatch } from "./shared/types";

function normalizeIdentity(value: string) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Fernando has a commercial rule where every validated route is usage,
 * regardless of whether the dispatch came from OCR, target or manual mode.
 * Exact emails can also be supplied for deployments where his login does not
 * contain his name.
 */
export function isAlwaysBillableValidatedRouteClient(clientEmail: string, configuredEmails = process.env.ALWAYS_BILL_VALIDATED_ROUTE_CLIENTS) {
  const email = normalizeIdentity(clientEmail);
  const configured = String(configuredEmails || "").split(",").map(normalizeIdentity).filter(Boolean);
  return email.split("@")[0].includes("fernando") || configured.includes(email);
}

export function validatedRouteUsagePayload(route: RouteDispatch, clientEmail: string) {
  const processedAt = route.ocr?.processedAt || route.validatedAt || route.updatedAt || route.createdAt;
  return {
    analysisId: route.ocr?.analysisId,
    routeDispatchId: route.id,
    clientEmail,
    messageId: route.sentMessageIds[0] || route.id,
    result: "detected" as const,
    route: route.ocr?.route || route.messages.join(" | "),
    bairro: route.ocr?.bairro,
    gaiola: route.ocr?.code,
    confidence: route.ocr?.confidence,
    groupJid: route.groupJid,
    groupName: route.groupName,
    analysisFinishedAt: processedAt,
    billingSource: route.ocr || route.decisionSource === "leader_reaction_1h" ? "ai" as const : route.trigger === "manual" ? "manual" as const : "target" as const
  };
}
