import { randomUUID } from 'node:crypto';
import contract from '../src/reading/shortcut-contract.json' with { type: 'json' };

export const shortcutText = value => typeof value === 'string' ? value : ({ WFSerializationType: 'WFTextTokenString',
  Value: { string: '\ufffc', attachmentsByRange: { '{0, 1}': value } } });
export const shortcutAttachment = value => ({ WFSerializationType: 'WFTextTokenAttachment', Value: value });
export const shortcutDictionary = entries => ({ WFSerializationType: 'WFDictionaryFieldValue',
  Value: { WFDictionaryFieldValueItems: entries.map(([key, value]) => ({ WFItemType: 0, WFKey: shortcutText(key), WFValue: shortcutText(value) })) } });
export function shortcutAction(identifier, parameters = {}, uuid = randomUUID()) {
  return { WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`, WFWorkflowActionParameters: { ...parameters, UUID: uuid } };
}
export const shortcutOutput = action => ({ Type: 'ActionOutput', OutputUUID: action.WFWorkflowActionParameters.UUID, OutputName: 'Result' });
export function shortcutFallbackUrl(stage) {
  return `${contract.supportUrl}#error=${encodeURIComponent(JSON.stringify({ stage, code: 'invalid_response', shortcutRevision: contract.revision, shortcutContract: contract.version }))}`;
}

// A response without a usable launch URL must still present an explanation.
// The public fallback carries fixed diagnostic fields, never a credential or URL.
export function shortcutSupportActions(launch, stage, { stop = false } = {}) {
  const variable = { Type: 'Variable', VariableName: 'Crate save page' };
  const group = randomUUID();
  const set = value => shortcutAction('setvariable', { WFVariableName: variable.VariableName, WFInput: shortcutAttachment(value) });
  const match = shortcutAction('text.match', { WFMatchTextPattern: '^https://[^\\s/?#@]+/notifications/save-reading(?:\\?[^\\s#]*)?#[^\\s]+$', text: shortcutText(launch) });
  const fallback = shortcutAction('gettext', { WFTextActionText: shortcutFallbackUrl(stage) });
  return [set(launch), match,
    shortcutAction('conditional', { GroupingIdentifier: group, WFControlFlowMode: 0, WFCondition: 101, WFInput: { Type: 'Variable', Variable: shortcutAttachment(shortcutOutput(match)) } }),
    fallback, set(shortcutOutput(fallback)),
    shortcutAction('conditional', { GroupingIdentifier: group, WFControlFlowMode: 2 }),
    shortcutAction('showwebpage', { WFURL: shortcutText(variable), WFEnterSafariReader: false }),
    ...(stop ? [shortcutAction('exit')] : []),
  ];
}

export function readingShortcutTemplate(template) {
  const workflow = structuredClone(template);
  const actions = workflow.WFWorkflowActions;
  actions[0].WFWorkflowActionParameters.WFTextActionText = `https://YOUR-CRATE-SERVER${contract.preparePath}`;
  workflow.WFWorkflowImportQuestions[0].DefaultValue = actions[0].WFWorkflowActionParameters.WFTextActionText;
  const request = actions.find(action => action.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl');
  // Private captures open the PWA with a fragment and have no capture request.
  if (!request) return workflow;
  request.WFWorkflowActionParameters.WFHTTPHeaders.Value.WFDictionaryFieldValueItems = [
    request.WFWorkflowActionParameters.WFHTTPHeaders.Value.WFDictionaryFieldValueItems[0],
    ...shortcutDictionary([[contract.revisionHeader, String(contract.revision)]]).Value.WFDictionaryFieldValueItems,
  ];
  const launch = actions.find(action => action.WFWorkflowActionParameters.WFDictionaryKey === 'launchUrl');
  workflow.WFWorkflowActions = [...actions.slice(0, actions.indexOf(launch) + 1), ...shortcutSupportActions(shortcutOutput(launch), 'prepare')];
  return workflow;
}
