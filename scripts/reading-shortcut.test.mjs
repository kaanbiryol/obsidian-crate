import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readingShortcutWithFirstRunSetup } from './reading-shortcut-first-run.mjs';

// Use the actual release template; plutil is also used by the macOS signing task.
const template = process.platform === 'darwin' ? JSON.parse(execFileSync('plutil', [
  '-convert', 'json', '-o', '-', fileURLToPath(new URL('../docs/shortcuts/save-to-crate.plist', import.meta.url)),
], { encoding: 'utf8' })) : null;
const nativeTest = (name, callback) => test(name, { skip: !template }, callback);
const identifier = action => action.WFWorkflowActionIdentifier.replace('is.workflow.actions.', '');
const token = value => {
  assert.equal(value.WFSerializationType, 'WFTextTokenString');
  assert.equal(value.Value.string, '\ufffc');
  return value.Value.attachmentsByRange['{0, 1}'];
};

nativeTest('first-run setup preserves capture actions and resolves every action output', () => {
  const before = structuredClone(template);
  const workflow = readingShortcutWithFirstRunSetup(template);
  assert.deepEqual(template, before);
  const actions = workflow.WFWorkflowActions;
  assert.deepEqual(actions[0], template.WFWorkflowActions[2]);
  assert.deepEqual(actions.slice(-4), template.WFWorkflowActions.slice(3));
  const seen = new Set();
  const check = value => {
    if (!value || typeof value !== 'object') return;
    if (value.Type === 'ActionOutput') assert.ok(seen.has(value.OutputUUID), `Unresolved output: ${value.OutputUUID}`);
    Object.values(value).forEach(check);
  };
  for (const action of actions) {
    check(action);
    const uuid = action.WFWorkflowActionParameters.UUID;
    assert.ok(!seen.has(uuid), `Duplicate action: ${uuid}`);
    seen.add(uuid);
  }
  const savedValues = actions.filter(action => identifier(action) === 'getvalueforkey').slice(0, 2);
  assert.deepEqual(savedValues.map(action => action.WFWorkflowActionParameters.WFDictionaryKey), ['endpoint', 'authorization']);
  assert.deepEqual(savedValues.map(action => action.WFWorkflowActionParameters.UUID), template.WFWorkflowActions.slice(0, 2).map(action => action.WFWorkflowActionParameters.UUID));
});

nativeTest('runtime prompt text reaches validation in the native text parameter format', () => {
  const actions = readingShortcutWithFirstRunSetup(template).WFWorkflowActions;
  const prompts = actions.filter(action => identifier(action) === 'ask');
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    const index = actions.indexOf(prompt);
    const trim = actions[index + 1].WFWorkflowActionParameters;
    // Bare WFTextTokenAttachment here silently lost the answer in native testing.
    assert.equal(token(trim.WFInput).OutputUUID, prompt.WFWorkflowActionParameters.UUID);
    const match = actions[index + 2].WFWorkflowActionParameters;
    assert.equal(token(match.text).OutputUUID, trim.UUID);
    assert.equal(trim.WFReplaceTextRegularExpression, true);
    assert.equal('  Bearer dummy  '.replace(new RegExp(trim.WFReplaceTextFind, 'g'), trim.WFReplaceTextReplace), 'Bearer dummy');
  }
});

nativeTest('distributed setup contains no import questions and uses shortcut-scoped storage', () => {
  const workflow = readingShortcutWithFirstRunSetup(template);
  assert.deepEqual(workflow.WFWorkflowImportQuestions, []);
  assert.ok(workflow.WFWorkflowMinimumClientVersion >= 5000);
  const storage = workflow.WFWorkflowActions.filter(action => ['getstoredcontent', 'setstoredcontent'].includes(identifier(action)));
  assert.equal(storage.length, 2);
  for (const action of storage) assert.equal(action.WFWorkflowActionParameters.WFStoredContentGlobalValue, false);
  assert.equal(storage[0].WFWorkflowActionParameters.WFStoredContentKey, storage[1].WFWorkflowActionParameters.WFStoredContentKey);
  assert.ok(!JSON.stringify(workflow).includes('YOUR-CAPTURE-CREDENTIAL'));
});

nativeTest('confirmation uses the prepared handoff in a web sheet without opening Safari', () => {
  for (const workflow of [template, readingShortcutWithFirstRunSetup(template)]) {
    const actions = workflow.WFWorkflowActions;
    assert.ok(!actions.some(action => identifier(action) === 'openurl'));
    const show = actions.at(-1);
    assert.equal(identifier(show), 'showwebpage');
    assert.equal(show.WFWorkflowActionParameters.WFEnterSafariReader, false);
    const handoff = actions.at(-2).WFWorkflowActionParameters;
    assert.equal(handoff.WFDictionaryKey, 'launchUrl');
    assert.equal(token(show.WFWorkflowActionParameters.WFURL).OutputUUID, handoff.UUID);
  }
});
