import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import contract from '../src/reading/shortcut-contract.json' with { type: 'json' };
import { readingShortcutWithFirstRunSetup } from './reading-shortcut-first-run.mjs';
import { privateShortcutSource, shortcutSource, shortcutTemplate, shortcutIdentifier as identifier, shortcutRequest, shortcutValue } from './reading-shortcut-fixture.mjs';

const workflows = () => [shortcutTemplate, readingShortcutWithFirstRunSetup(shortcutSource), readingShortcutWithFirstRunSetup(shortcutSource, { pairing: true })];
const token = value => {
  assert.equal(value.WFSerializationType, 'WFTextTokenString'); assert.equal(value.Value.string, '\ufffc');
  return value.Value.attachmentsByRange['{0, 1}'];
};
test('portable release fixture matches the macOS signing parser', { skip: process.platform !== 'darwin' }, () => {
  assert.deepEqual(shortcutSource, JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', fileURLToPath(new URL('../tests/fixtures/reading-shortcut-v1.plist', import.meta.url))], { encoding: 'utf8' })));
});
test('all signed variants preserve shared input and resolve every action output', () => {
  const before = structuredClone(shortcutSource);
  for (const workflow of workflows()) {
    const seen = new Set();
    const check = value => {
      if (!value || typeof value !== 'object') return;
      if (value.Type === 'ActionOutput') assert.ok(seen.has(value.OutputUUID), `Unresolved output: ${value.OutputUUID}`);
      Object.values(value).forEach(check);
    };
    for (const action of workflow.WFWorkflowActions) {
      check(action); const uuid = action.WFWorkflowActionParameters.UUID;
      assert.ok(!seen.has(uuid), `Duplicate action: ${uuid}`); seen.add(uuid);
    }
    assert.deepEqual(workflow.WFWorkflowActions.find(action => identifier(action) === 'detect.link'), shortcutSource.WFWorkflowActions[2]);
    assert.deepEqual(workflow.WFWorkflowActions.find(action => identifier(action) === 'getitemfromlist'), shortcutSource.WFWorkflowActions[3]);
  }
  assert.deepEqual(shortcutSource, before);
});
test('runtime prompt text reaches validation in the native text parameter format', () => {
  const actions = readingShortcutWithFirstRunSetup(shortcutSource).WFWorkflowActions;
  const prompts = actions.filter(action => identifier(action) === 'ask'); assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    const index = actions.indexOf(prompt), trim = actions[index + 1].WFWorkflowActionParameters;
    assert.equal(token(trim.WFInput).OutputUUID, prompt.WFWorkflowActionParameters.UUID);
    assert.equal(token(actions[index + 2].WFWorkflowActionParameters.text).OutputUUID, trim.UUID);
    assert.equal('  Bearer dummy  '.replace(new RegExp(trim.WFReplaceTextFind, 'g'), trim.WFReplaceTextReplace), 'Bearer dummy');
  }
});
test('distributed first-run setup uses shortcut-scoped storage without import questions or credentials', () => {
  for (const workflow of workflows().slice(1)) {
    assert.deepEqual(workflow.WFWorkflowImportQuestions, []); assert.ok(workflow.WFWorkflowMinimumClientVersion >= 5000);
    const storage = workflow.WFWorkflowActions.filter(action => ['getstoredcontent', 'setstoredcontent'].includes(identifier(action)));
    assert.equal(storage.length, 2);
    for (const action of storage) assert.equal(action.WFWorkflowActionParameters.WFStoredContentGlobalValue, false);
    assert.equal(storage[0].WFWorkflowActionParameters.WFStoredContentKey, storage[1].WFWorkflowActionParameters.WFStoredContentKey);
    assert.ok(!JSON.stringify(workflow).includes('YOUR-CAPTURE-CREDENTIAL'));
  }
});
test('every signed request uses the independent shortcut contract rather than an app wire version', () => {
  for (const workflow of workflows()) {
    const outputs = Object.fromEntries(workflow.WFWorkflowActions.map(action => [action.WFWorkflowActionParameters.UUID, 'test value']));
    for (const action of workflow.WFWorkflowActions.filter(action => identifier(action) === 'downloadurl')) {
      const request = shortcutRequest(action, outputs);
      assert.equal(request.headers['X-Crate-Protocol'], undefined);
      assert.equal(request.headers[contract.revisionHeader], String(contract.revision));
    }
  }
});

// Exercise the serialized native branch, including its variable wiring. This
// only interprets the small presentation tail; it cannot establish iOS behavior.
function presentation(actions, initial) {
  const outputs = { ...initial }, variables = {}, conditions = [], pages = [];
  for (const action of actions) {
    const p = action.WFWorkflowActionParameters, kind = identifier(action);
    if (kind === 'conditional') {
      if (p.WFControlFlowMode === 2) { conditions.pop(); continue; }
      assert.equal(p.WFControlFlowMode, 0); assert.equal(p.WFCondition, 101);
      const input = shortcutValue(p.WFInput, outputs, variables);
      conditions.push(input == null || input === '' || Array.isArray(input) && input.length === 0); continue;
    }
    if (conditions.some(active => !active)) continue;
    if (kind === 'setvariable') variables[p.WFVariableName] = shortcutValue(p.WFInput, outputs, variables);
    else if (kind === 'text.match') outputs[p.UUID] = new RegExp(p.WFMatchTextPattern).test(String(shortcutValue(p.text, outputs, variables) ?? '')) ? ['match'] : [];
    else if (kind === 'gettext') outputs[p.UUID] = p.WFTextActionText;
    else if (kind === 'showwebpage') { assert.equal(p.WFEnterSafariReader, false); pages.push(shortcutValue(p.WFURL, outputs, variables)); }
    else throw new Error(`Unexpected presentation action: ${kind}`);
  }
  return pages;
}
test('missing, malformed, and non-HTTPS preparation URLs open a support page without leaking the response', () => {
  for (const workflow of workflows()) {
    const actions = workflow.WFWorkflowActions;
    const index = actions.findIndex(action => action.WFWorkflowActionParameters.UUID === shortcutSource.WFWorkflowActions[5].WFWorkflowActionParameters.UUID);
    const uuid = actions[index].WFWorkflowActionParameters.UUID;
    const valid = `https://crate.example/notifications/save-reading?shortcut=2#${'a'.repeat(64)}`;
    assert.deepEqual(presentation(actions.slice(index + 1), { [uuid]: valid }), [valid]);
    for (const invalid of [undefined, '', 'http://crate.example/notifications/save-reading#secret', 'https://other.example/private?token=secret']) {
      const [url] = presentation(actions.slice(index + 1), { [uuid]: invalid });
      assert.equal(url.split('#')[0], contract.supportUrl);
      assert.deepEqual(JSON.parse(decodeURIComponent(new URL(url).hash.slice('#error='.length))), {
        stage: 'prepare', code: 'invalid_response', shortcutRevision: contract.revision, shortcutContract: contract.version,
      });
      assert.ok(!url.includes('secret'));
    }
    assert.ok(!actions.some(action => identifier(action) === 'openurl'));
  }
});
test('PWA pairing sends a one-use code only in JSON and saves access after validation', () => {
  const actions = readingShortcutWithFirstRunSetup(shortcutSource, { pairing: true }).WFWorkflowActions;
  assert.equal(actions.filter(action => identifier(action) === 'ask').length, 1);
  const checks = actions.filter(action => identifier(action) === 'text.match');
  const pattern = new RegExp(checks[0].WFWorkflowActionParameters.WFMatchTextPattern);
  const code = `https://crate.example/reading/shortcut-exchange#${'a'.repeat(64)}`;
  assert.ok(pattern.test(code));
  for (const invalid of [code.replace('https:', 'http:'), code.replace('crate.example', 'user@crate.example'), code.replace('#', '?token='), code + 'extra']) assert.ok(!pattern.test(invalid));
  const action = actions.find(action => identifier(action) === 'downloadurl'), p = action.WFWorkflowActionParameters;
  const urlAction = actions.find(action => action.WFWorkflowActionParameters.UUID === token(p.WFURL).OutputUUID).WFWorkflowActionParameters;
  const originAction = actions.find(action => action.WFWorkflowActionParameters.UUID === token(urlAction.WFInput).OutputUUID).WFWorkflowActionParameters;
  const origin = code.replace(new RegExp(originAction.WFReplaceTextFind), originAction.WFReplaceTextReplace);
  assert.equal(origin.replace(new RegExp(urlAction.WFReplaceTextFind), urlAction.WFReplaceTextReplace), `https://crate.example${contract.exchangePath}`);
  assert.equal(p.WFHTTPMethod, 'POST'); assert.equal(p.WFHTTPBodyType, 'JSON');
  assert.deepEqual(p.WFJSONValues.Value.WFDictionaryFieldValueItems.map(field => field.WFKey), ['token']);
  assert.deepEqual(p.WFHTTPHeaders.Value.WFDictionaryFieldValueItems.map(field => field.WFKey), [contract.revisionHeader]);
  const store = actions.findIndex(action => identifier(action) === 'setstoredcontent');
  const validation = actions.indexOf(checks.find(action => action.WFWorkflowActionParameters.WFMatchTextPattern === '^Bearer [a-f0-9]{64}$'));
  assert.ok(store > validation);
  assert.ok(actions.slice(validation, store).some(action => identifier(action) === 'showwebpage'));
  assert.ok(actions.slice(validation, store).some(action => identifier(action) === 'exit'));
});
test('stored legacy endpoints are upgraded locally without another pairing request', () => {
  const actions = readingShortcutWithFirstRunSetup(shortcutSource, { pairing: true }).WFWorkflowActions;
  const endpoint = actions.find(action => action.WFWorkflowActionParameters.UUID === shortcutSource.WFWorkflowActions[0].WFWorkflowActionParameters.UUID);
  assert.equal(identifier(endpoint), 'text.replace');
  const p = endpoint.WFWorkflowActionParameters;
  for (const path of ['/reading/prepare', contract.preparePath]) assert.equal(`https://crate.example${path}`.replace(new RegExp(p.WFReplaceTextFind), p.WFReplaceTextReplace), `https://crate.example${contract.preparePath}`);
});


test('private capture variants keep URLs in fragments and resolve their native outputs', () => {
  for (const workflow of [privateShortcutSource, readingShortcutWithFirstRunSetup(privateShortcutSource), readingShortcutWithFirstRunSetup(privateShortcutSource, { pairing: true })]) {
    const actions = workflow.WFWorkflowActions, capture = actions.slice(-5), seen = new Set();
    const check = value => {
      if (!value || typeof value !== 'object') return;
      if (value.Type === 'ActionOutput') assert.ok(seen.has(value.OutputUUID), `Unresolved output: ${value.OutputUUID}`);
      Object.values(value).forEach(check);
    };
    for (const action of actions) { check(action); const id = action.WFWorkflowActionParameters.UUID; assert.ok(!seen.has(id)); seen.add(id); }
    assert.deepEqual(capture.map(identifier), ['getitemfromlist', 'urlencode', 'text.replace', 'gettext', 'openurl']);
    assert.equal(capture[1].WFWorkflowActionParameters.WFEncodeMode, 'Encode');
    assert.equal(token(capture[1].WFWorkflowActionParameters.WFInput).OutputUUID, capture[0].WFWorkflowActionParameters.UUID);
    const prefix = capture[2].WFWorkflowActionParameters;
    for (const path of ['/reading/prepare', contract.preparePath]) assert.equal(('https://crate.example' + path).replace(new RegExp(prefix.WFReplaceTextFind), prefix.WFReplaceTextReplace), 'https://crate.example/notifications?section=reading#readingCapture=');
    const assembled = capture[3].WFWorkflowActionParameters.WFTextActionText;
    assert.equal(assembled.Value.attachmentsByRange['{0, 1}'].OutputUUID, prefix.UUID);
    assert.equal(assembled.Value.attachmentsByRange['{1, 1}'].OutputUUID, capture[1].WFWorkflowActionParameters.UUID);
    assert.equal(token(capture[4].WFWorkflowActionParameters.WFInput).OutputUUID, capture[3].WFWorkflowActionParameters.UUID);
  }
});
