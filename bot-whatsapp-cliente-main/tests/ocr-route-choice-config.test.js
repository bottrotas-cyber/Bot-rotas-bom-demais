const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigStore } = require("../dist/bot/config.js");

test("configuracao antiga recebe cerebro por menor numero de paradas", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-choice-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify({ nomeEnvio: "Cliente" }));
  const config = new ConfigStore(file).load();
  assert.equal(config.ocrRouteChoiceMode, "quantity");
  assert.equal(config.ocrRouteChoiceMetric, "stops");
});

test("cerebro escolhido pelo cliente permanece salvo apos reinicio", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-choice-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json");
  new ConfigStore(file).save({ ocrRouteChoiceMode: "preference", ocrRouteChoiceMetric: "packages" });
  const restored = new ConfigStore(file).load();
  assert.equal(restored.ocrRouteChoiceMode, "preference");
  assert.equal(restored.ocrRouteChoiceMetric, "packages");
});
