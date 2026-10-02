import { readFile } from 'node:fs/promises';
import { DOMParser } from 'linkedom';
import { readingShortcutTemplate } from './reading-shortcut-template.mjs';

// Read the release source on every test platform, including Linux CI.
const parseSource = async path => plist(new DOMParser().parseFromString(await readFile(new URL(path, import.meta.url), 'utf8'), 'text/xml').documentElement.firstElementChild);
function plist(element) {
  const children = [...element.children];
  switch (element.localName) {
    case 'dict': return Object.fromEntries(children.filter((_, index) => index % 2 === 0)
      .map((key, index) => [key.textContent, plist(children[index * 2 + 1])]));
    case 'array': return children.map(plist);
    case 'string': return element.textContent;
    case 'integer': return Number(element.textContent);
    case 'true': return true;
    case 'false': return false;
    default: throw new Error(`Unsupported shortcut plist value: ${element.localName}`);
  }
}
// Frozen source for compatibility tests of already distributed native captures.
export const shortcutSource = await parseSource('../tests/fixtures/reading-shortcut-v1.plist');
export const privateShortcutSource = await parseSource('../docs/shortcuts/save-to-crate.plist');
export const shortcutTemplate = readingShortcutTemplate(shortcutSource);
export const shortcutIdentifier = action => action.WFWorkflowActionIdentifier.replace('is.workflow.actions.', '');

// Resolve the real serialized request rather than supplying known-good headers
// in the server/browser tests. Native Shortcuts still needs device acceptance.
export function shortcutValue(input, outputs, variables = {}) {
  const value = input => {
    if (typeof input === 'string') return input;
    if (input.WFSerializationType === 'WFDictionaryFieldValue') return Object.fromEntries(input.Value.WFDictionaryFieldValueItems
      .map(field => [value(field.WFKey), value(field.WFValue)]));
    if (input.WFSerializationType === 'WFTextTokenString') {
      if (!input.Value.attachmentsByRange) return input.Value.string;
      if (input.Value.string !== '\ufffc') throw new Error('Expected a single shortcut request variable.');
      return value(input.Value.attachmentsByRange['{0, 1}']);
    }
    if (input.WFSerializationType === 'WFTextTokenAttachment') return value(input.Value);
    if (input.Type === 'ActionOutput' && Object.hasOwn(outputs, input.OutputUUID)) return outputs[input.OutputUUID];
    if (input.Type === 'Variable' && input.Variable) return value(input.Variable);
    if (input.Type === 'Variable' && Object.hasOwn(variables, input.VariableName)) return variables[input.VariableName];
    throw new Error('Unresolved shortcut request value.');
  };
  return value(input);
}
export function shortcutRequest(action, outputs) {
  const value = input => shortcutValue(input, outputs);
  const parameters = action.WFWorkflowActionParameters;
  return { url: value(parameters.WFURL), method: parameters.WFHTTPMethod,
    headers: { ...value(parameters.WFHTTPHeaders), 'Content-Type': 'application/json' },
    body: JSON.stringify(value(parameters.WFJSONValues)) };
}
