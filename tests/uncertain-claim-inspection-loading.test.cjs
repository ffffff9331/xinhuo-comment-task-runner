"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// Reuse the frozen inert DOM fixture without registering or changing its tests.
const filename = path.join(__dirname, "uncertain-claim-inspection.test.cjs");
const source = fs.readFileSync(filename, "utf8");
const boundary = source.indexOf("function assertReadOnly(p)");
assert.ok(boundary > 0);
const fixture = new Module(filename, module);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(__dirname);
fixture._compile(source.slice(0, boundary) + "\nmodule.exports = { page };", filename);
const { page } = fixture.exports;

for (const kind of ["document", "missing panel", "hidden panel", "busy panel", "busy child", "loading text"]) {
  test(`only explicit ${kind} hydration allows a bounded inspection reread`, async () => {
    const p = page({ buttons: ["接取评论任务"], ...(kind === "missing panel" ? { noPanel: true } : {}) });
    if (kind === "document") p.document.readyState = "loading";
    if (kind === "hidden panel") p.panel.hidden = true;
    if (kind === "busy panel") p.panel.attrs["aria-busy"] = "true";
    if (kind === "busy child") p.panel.append(p.node("div", "", { "aria-busy": "true" }));
    if (kind === "loading text") p.panel.append(p.node("p", "正在加载订单"));
    const result = await p.send();
    assert.equal(result.ok, false);
    assert.equal(result.inspectionState, "unknown");
    assert.equal(result.inspectionLoading, true);
    assert.notEqual(result.claimed, false);
    assert.equal(p.calls.clicks, 0);
    assert.equal(p.calls.messages.length, 0);
  });
}

for (const kind of ["missing controls", "multiple panels", "mismatching tweet", "mismatching path", "multiple panels while loading", "mismatching tweet while loading"]) {
  test(`${kind} is not a hydration retry authorization`, async () => {
    const p = page({ panelText: "E0席位 审核通过后奖励 0 KX" });
    if (kind.startsWith("multiple panels")) p.main.append(p.node("aside", "本单任务", { class: "reward-panel" }));
    if (kind.startsWith("mismatching tweet")) p.anchors[0].attrs.href = "https://x.com/other/status/999";
    if (kind === "mismatching path") p.c.location.pathname = "/tasks/other";
    if (kind.endsWith("while loading")) p.document.readyState = "loading";
    const result = await p.send();
    assert.equal(result.inspectionState, "unknown");
    assert.notEqual(result.inspectionLoading, true);
    assert.notEqual(result.claimed, false);
    assert.equal(p.calls.clicks, 0);
  });
}
