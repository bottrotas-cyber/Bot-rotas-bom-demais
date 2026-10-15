const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ImageUsageStore } = require("../dist/imageUsageStore.js");
const { RouteStore } = require("../dist/bot/routeStore.js");

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-usage-test-"));
  return path.join(dir, name);
}

test("contabiliza somente análises aprovadas e mantém testes excluídos", () => {
  const store = new ImageUsageStore(tempFile("usage.json"));
  store.setDefaultAmount("cliente@teste.com", 750);
  store.record({ id: "foto-1", clientEmail: "cliente@teste.com", messageId: "1", result: "detected", gaiola: "F-14" });
  store.record({ id: "foto-2", clientEmail: "cliente@teste.com", messageId: "2", result: "unreadable" });
  store.decide("foto-1", "billable", "admin@teste.com", 900);
  store.decide("foto-2", "excluded", "admin@teste.com");

  const clientSnapshot = store.clientSnapshot("cliente@teste.com");
  assert.equal(clientSnapshot.amountCents, 900);
  assert.equal(clientSnapshot.unpaidRoutes, 1);
  assert.equal("prepaidRoutesRemaining" in clientSnapshot, false);
});

test("não duplica consumo quando o mesmo evento de imagem chega novamente", () => {
  const store = new ImageUsageStore(tempFile("usage.json"));
  const input = { id: "foto-repetida", clientEmail: "cliente@teste.com", messageId: "1", result: "detected" };
  store.record(input);
  store.record(input);
  assert.equal(store.snapshot().totals.total, 1);
});

test("Fernando fecha cobrança a cada 10 rotas validadas e reinicia o ciclo ao registrar pagamento", () => {
  const store = new ImageUsageStore(tempFile("usage-cadence.json"));
  const email = "fernando@teste.com";
  assert.equal(store.paymentEveryRoutes(email), 10);
  for (let index = 1; index <= 9; index += 1) {
    store.decideValidatedRoute({ routeDispatchId: `rota-${index}`, clientEmail: email, messageId: `msg-${index}`, result: "detected", gaiola: `F-${index}` }, "admin@teste.com");
  }
  assert.equal(store.clientSnapshot(email).unpaidRoutes, 9);
  assert.equal(store.clientSnapshot(email).billingReminder, undefined);
  store.decideValidatedRoute({ routeDispatchId: "rota-10", clientEmail: email, messageId: "msg-10", result: "detected", gaiola: "F-10" }, "admin@teste.com");
  assert.match(store.clientSnapshot(email).billingReminder, /10 rotas/);
  assert.equal(store.clientSnapshot(email).unpaidRoutes, 10);
  store.registerPayment(email);
  assert.equal(store.clientSnapshot(email).unpaidRoutes, 0);
  assert.equal(store.clientSnapshot(email).billingReminder, undefined);
});

test("usa R$ 0,70 como padrão e preserva telemetria da análise", () => {
  const store = new ImageUsageStore(tempFile("usage.json"));
  store.record({
    id: "foto-com-tempo",
    clientEmail: "cliente@teste.com",
    messageId: "3",
    result: "detected",
    groupJid: "motoristas@g.us",
    groupName: "Motoristas",
    analysisStartedAt: "2026-07-18T10:00:00.000Z",
    analysisFinishedAt: "2026-07-18T10:00:04.250Z",
    analysisDurationMs: 4250
  });
  assert.equal(store.decideForRoute("foto-com-tempo", "rota-3", "billable", "Líder: Teste"), true);
  assert.equal(store.decideForRoute("foto-com-tempo", "rota-3", "billable", "Líder: Teste"), false);

  const entry = store.get("foto-com-tempo");
  assert.equal(entry.amountCents, 70);
  assert.equal(entry.groupName, "Motoristas");
  assert.equal(entry.analysisDurationMs, 4250);
  assert.equal(entry.routeDispatchId, "rota-3");
  assert.equal(entry.reviewedBy, "Líder: Teste");
  assert.equal(store.clientSnapshot("cliente@teste.com").amountCents, 70);
});

test("validação automática antiga cria consumo quando a análise ainda não estava ligada", () => {
  const store = new ImageUsageStore(tempFile("usage-legacy-validation.json"));
  const input = {
    routeDispatchId: "rota-legada-1",
    clientEmail: "cliente@teste.com",
    messageId: "mensagem-enviada-1",
    result: "detected",
    gaiola: "C-17",
    groupJid: "motoristas@g.us",
    analysisFinishedAt: "2026-08-31T10:00:00.000Z"
  };

  assert.equal(store.decideValidatedRoute(input, "Líder: Teste"), true);
  assert.equal(store.decideValidatedRoute(input, "Líder: Teste"), false);
  assert.equal(store.snapshot().totals.total, 1);
  assert.equal(store.snapshot().totals.billable, 1);
  assert.equal(store.clientSnapshot("cliente@teste.com").amountCents, 70);
});

test("validação legada reaproveita análise pendente próxima sem cobrar duas vezes", () => {
  const store = new ImageUsageStore(tempFile("usage-legacy-link.json"));
  store.record({
    id: "foto-pendente",
    clientEmail: "cliente@teste.com",
    messageId: "foto-1",
    result: "detected",
    gaiola: "C-17",
    analysisFinishedAt: "2026-08-31T10:00:00.000Z"
  });

  store.decideValidatedRoute({
    routeDispatchId: "rota-legada-2",
    clientEmail: "cliente@teste.com",
    messageId: "mensagem-enviada-2",
    result: "detected",
    gaiola: "C-17",
    analysisFinishedAt: "2026-08-31T10:01:00.000Z"
  }, "Líder: Teste");

  assert.equal(store.snapshot().totals.total, 1);
  assert.equal(store.get("foto-pendente").routeDispatchId, "rota-legada-2");
  assert.equal(store.get("foto-pendente").decision, "billable");
});

test("permite substituir o total mensal calculado por cliente", () => {
  const filePath = tempFile("usage-total-manual.json");
  const store = new ImageUsageStore(filePath);
  store.record({ id: "foto-total", clientEmail: "alan@teste.com", messageId: "4", result: "detected" });
  store.decide("foto-total", "billable", "admin@teste.com", 570);
  store.setMonthlyTotal("alan@teste.com", 1000);

  const snapshot = store.snapshot();
  const client = snapshot.clients.find((item) => item.clientEmail === "alan@teste.com");
  assert.equal(client.amountCents, 1000);
  assert.equal(client.manualTotalAmountCents, 1000);
  assert.equal(snapshot.totals.amountCents, 1000);
  assert.equal(store.clientSnapshot("alan@teste.com").amountCents, 1000);
  assert.equal(new ImageUsageStore(filePath).clientSnapshot("alan@teste.com").amountCents, 1000);
});

function createPendingRoute(store, id = "rota-lider") {
  return store.create({
    id,
    clientEmail: "cliente@teste.com",
    groupJid: "motoristas@g.us",
    groupName: "Motoristas",
    mode: "target",
    trigger: "automatic",
    messages: ["Rota F-14"],
    sentMessageIds: ["mensagem-1"],
    confirmedCount: 1,
    totalCount: 1,
    status: "sent"
  });
}

test("reação permanece pendente até decisão manual do admin", () => {
  const store = new RouteStore(tempFile("routes-auto.json"));
  createPendingRoute(store);
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  store.recordReactionEvent("mensagem-1", {
    id: "mensagem-1:lider:reacao",
    timestamp: new Date(now - 61 * 60_000).toISOString(),
    emoji: "✅",
    senderJid: "lider@s.whatsapp.net",
    senderPhone: "5522999999999",
    isAdmin: true,
    leaderName: "Líder Teste"
  }, "add");

  assert.equal(store.all()[0].decisionStatus, "pending");
  assert.equal(store.validate("rota-lider", "admin@teste.com"), true);
  assert.equal(store.all()[0].decisionStatus, "validated");
  assert.equal(store.all()[0].decisionSource, "admin_manual");
});

test("valida rota enviada quando líder reage com joia", () => {
  const store = new RouteStore(tempFile("routes-leader-thumbs.json"));
  createPendingRoute(store, "rota-joia");

  assert.equal(store.validateBySentMessageId("mensagem-1", "Líder Teste", {
    source: "leader_reaction_1h",
    reason: "Validada automaticamente por reação de joia do líder.",
    reactionAt: "2026-07-18T12:00:00.000Z",
    leaderName: "Líder Teste"
  }), true);

  const route = store.all()[0];
  assert.equal(route.decisionStatus, "validated");
  assert.equal(route.validatedBy, "Líder Teste");
  assert.equal(route.validationLeaderName, "Líder Teste");
  assert.equal(route.validationReactionAt, "2026-07-18T12:00:00.000Z");
});

test("admin pode rejeitar manualmente uma rota reagida", () => {
  const store = new RouteStore(tempFile("routes-override.json"));
  createPendingRoute(store, "rota-override");
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  store.recordReactionEvent("mensagem-1", {
    id: "mensagem-1:lider:override",
    timestamp: new Date(now - 61 * 60_000).toISOString(),
    emoji: "✅",
    senderJid: "lider@s.whatsapp.net",
    senderPhone: "5522999999999",
    isAdmin: true,
    leaderName: "Líder Teste"
  }, "add");
  assert.equal(store.reject("rota-override", "admin@teste.com", "Teste do cliente"), true);

  const route = store.all()[0];
  assert.equal(route.decisionStatus, "rejected");
  assert.equal(route.decisionSource, "admin_manual");
  assert.equal(route.validationLeaderName, undefined);
});

test("remoção de reação também permanece pendente para análise manual", () => {
  const store = new RouteStore(tempFile("routes-remove.json"));
  createPendingRoute(store, "rota-removida");
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const base = {
    emoji: "✅",
    senderJid: "lider@s.whatsapp.net",
    senderPhone: "5522999999999",
    isAdmin: true,
    leaderName: "Líder Teste"
  };
  store.recordReactionEvent("mensagem-1", { ...base, id: "mensagem-1:lider:add", timestamp: new Date(now - 70 * 60_000).toISOString() }, "add");
  store.recordReactionEvent("mensagem-1", { ...base, id: "mensagem-1:lider:remove", timestamp: new Date(now - 10 * 60_000).toISOString(), emoji: "" }, "remove");

  assert.equal(store.all()[0].decisionStatus, "pending");
});

test("recupera histórico de rotas pelo backup se o arquivo principal ficar inválido", () => {
  const filePath = tempFile("routes.json");
  const store = new RouteStore(filePath);
  store.create({
    id: "rota-1",
    clientEmail: "cliente@teste.com",
    groupJid: "grupo@g.us",
    groupName: "Motoristas",
    mode: "target",
    trigger: "automatic",
    messages: ["Rota F-14"],
    sentMessageIds: [],
    confirmedCount: 0,
    totalCount: 1,
    status: "sending"
  });
  store.flush();
  store.validate("rota-1", "admin@teste.com");
  store.flush();
  fs.writeFileSync(filePath, "{arquivo interrompido");

  const recovered = new RouteStore(filePath).all();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, "rota-1");
});
