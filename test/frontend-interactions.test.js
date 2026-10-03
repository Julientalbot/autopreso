import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function editorHarness(name, settings) {
  const state = [];
  let cursor = 0;
  const saved = [];
  const context = vm.createContext({
    React: {
      useState: (initial) => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = value; }];
      },
      useEffect: () => {},
      createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    },
  });
  vm.runInContext(source.slice(source.indexOf("const SAMPLE_RATE"), source.lastIndexOf("createRoot(")), context);
  const component = vm.runInContext(name, context);
  return {
    saved,
    render: () => {
      cursor = 0;
      return component({ settings, onSave: async (patch) => saved.push(patch), onCancel: () => {} });
    },
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

for (const editor of ["AgentEditor", "TranscriptionEditor"]) {
  for (const provider of ["xai", "openai"]) {
    test(`${editor} keeps a first-time ${provider} key editable until save`, async () => {
      const settings = {
        hasXAIKey: false,
        hasOpenAIKey: false,
        agent: { provider, xai: { model: "grok-4.3" }, openai: {}, codex: {}, ollama: {} },
        transcription: { provider, xai: { language: "en" }, openai: {}, moonshine: {} },
      };
      const harness = editorHarness(editor, settings);
      let tree = harness.render();
      const password = () => findNode(tree, (node) => node.type === "input" && node.props.type === "password");
      const save = () => findNode(tree, (node) => node.type === "button" && node.children.includes("Save"));
      assert.equal(save().props.disabled, true);
      for (const value of ["x", "xa", "", `${provider}-complete-key`, `${provider}-corrected-key`]) {
        assert.ok(password(), "API key input must remain mounted while editing");
        password().props.onChange({ target: { value } });
        tree = harness.render();
        assert.ok(password(), "API key input must remain mounted after typing");
        assert.equal(password().props.value, value);
        assert.equal(save().props.disabled, value === "");
      }
      await save().props.onClick();
      assert.equal(harness.saved[0].apiKeys[provider], `${provider}-corrected-key`);
    });
  }
}

function sceneHarness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const existing = [{ type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 100 }];
  let scene = existing;
  const context = vm.createContext({
    modeRef: { current: "live" },
    listeningRef: { current: false },
    pendingSceneRef: { current: null },
    apiRef: { current: { getSceneElements: () => scene } },
    userElementsSyncTimerRef: { current: null },
    lastSyncedElementsHashRef: { current: JSON.stringify(existing) },
    wsRef: { current: { readyState: 1, send: (message) => sent.push(JSON.parse(message)) } },
    WebSocket: { OPEN: 1 },
    setTimeout,
    clearTimeout,
  });
  const handler = source.slice(source.indexOf("  function handleExcalidrawChange("), source.indexOf("  // Persistent WebSocket"));
  const conversion = source.slice(source.indexOf("function nativeElementsToSkeletonForSync("), source.indexOf("function blobToDataUrl("));
  vm.runInContext(conversion + handler, context);
  const onChange = vm.runInContext("handleExcalidrawChange", context);
  return { sent, existing, context, onChange, setScene: (elements) => { scene = elements; } };
}

test("live canvas sends deletion of every element while listening is stopped", (t) => {
  const harness = sceneHarness(t);
  harness.setScene([]);
  harness.onChange(harness.existing.map((element) => ({ ...element, isDeleted: true })));
  t.mock.timers.tick(500);
  assert.deepEqual(harness.sent, [{ type: "whiteboard:user-elements", elements: [] }]);
});

test("empty initialization callback does not clear the current live scene", (t) => {
  const harness = sceneHarness(t);
  harness.onChange([]);
  t.mock.timers.tick(500);
  assert.deepEqual(harness.sent, []);
});

test("pending canvas sync cannot overwrite staging or an active listening session", (t) => {
  const harness = sceneHarness(t);
  const edited = [...harness.existing, { type: "text", id: "text", text: "new" }];
  harness.setScene(edited);
  harness.onChange(edited);
  harness.context.listeningRef.current = true;
  t.mock.timers.tick(500);
  assert.deepEqual(harness.sent, []);
});
