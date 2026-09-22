import { randomUUID } from 'node:crypto';

// iOS 27 / macOS 27 provide storage scoped to a shortcut. The distributed
// template has no credentials or import questions; configuration happens at run time.
export function readingShortcutWithFirstRunSetup(template) {
  const workflow = structuredClone(template);
  const original = workflow.WFWorkflowActions;
  const actions = [];
  const storedKey = 'crate.capture.configuration';
  const configuration = { Type: 'Variable', VariableName: 'Crate configuration' };
  const attachment = value => ({ WFSerializationType: 'WFTextTokenAttachment', Value: value });
  const text = value => typeof value === 'string' ? value : ({
    WFSerializationType: 'WFTextTokenString',
    Value: { string: '\ufffc', attachmentsByRange: { '{0, 1}': value } },
  });
  const add = (identifier, parameters = {}, uuid = randomUUID()) => {
    actions.push({ WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`, WFWorkflowActionParameters: { ...parameters, UUID: uuid } });
    return { Type: 'ActionOutput', OutputUUID: uuid, OutputName: 'Result' };
  };
  const setConfiguration = value => add('setvariable', { WFVariableName: configuration.VariableName, WFInput: attachment(value) });
  const whenEmpty = value => {
    const group = randomUUID();
    add('conditional', { GroupingIdentifier: group, WFControlFlowMode: 0, WFCondition: 101, WFInput: { Type: 'Variable', Variable: attachment(value) } });
    return group;
  };
  const otherwise = group => add('conditional', { GroupingIdentifier: group, WFControlFlowMode: 1 });
  const end = group => add('conditional', { GroupingIdentifier: group, WFControlFlowMode: 2 });
  const alert = (title, message) => add('alert', { WFAlertActionTitle: title, WFAlertActionMessage: message, WFAlertActionCancelButtonShown: false });
  const ask = (prompt, pattern, message) => {
    const answer = add('ask', { WFAskActionPrompt: prompt, WFInputType: 'Text' });
    const trimmed = add('text.replace', { WFReplaceTextFind: '^\\s+|\\s+$', WFReplaceTextReplace: '', WFReplaceTextRegularExpression: true, WFInput: text(answer) });
    const match = add('text.match', { WFMatchTextPattern: pattern, text: text(trimmed) });
    const invalid = whenEmpty(match);
    alert('Check your Crate setup', message);
    add('exit');
    end(invalid);
    return trimmed;
  };

  // A library tap opens setup again, so replacing expired access or changing
  // servers never requires editing actions. Sharing a link reuses saved access.
  actions.push(original[2]);
  const incoming = { Type: 'ActionOutput', OutputUUID: original[2].WFWorkflowActionParameters.UUID, OutputName: 'URLs' };
  const setupOnly = whenEmpty(incoming);
  setConfiguration(add('nothing'));
  otherwise(setupOnly);
  setConfiguration(add('getstoredcontent', { WFStoredContentKey: storedKey, WFStoredContentGlobalValue: false }));
  end(setupOnly);

  const needsSetup = whenEmpty(configuration);
  const endpoint = ask('Paste the endpoint from Crate → Reading → Set up shortcut. Crate will remember it in this shortcut.', '^https://[^\\s?#]+/reading/prepare$', 'Paste the full HTTPS endpoint ending in /reading/prepare, then run setup again.');
  const authorization = ask('Paste the complete Authorization header from Crate, including Bearer. It will be saved in this shortcut.', '^Bearer [A-Za-z0-9._~+/-]+=*$', 'Paste the complete Bearer header from Crate, then run setup again.');
  const values = add('dictionary', { WFItems: {
    WFSerializationType: 'WFDictionaryFieldValue',
    Value: { WFDictionaryFieldValueItems: [
      { WFItemType: 0, WFKey: text('endpoint'), WFValue: text(endpoint) },
      { WFItemType: 0, WFKey: text('authorization'), WFValue: text(authorization) },
    ] },
  } });
  // Store both values together only after validation. Cancellation leaves the
  // previous configuration intact and never initiates a save request.
  add('setstoredcontent', { WFStoredContentKey: storedKey, WFStoredContentGlobalValue: false, WFInput: text(values) });
  setConfiguration(values);
  end(needsSetup);

  const configuredWithoutLink = whenEmpty(incoming);
  alert('Crate setup saved', 'In Safari or another app, share a link and choose Save to Crate (iOS 27). Run this shortcut from your library to change your setup.');
  add('exit');
  end(configuredWithoutLink);

  for (const [index, key] of ['endpoint', 'authorization'].entries()) {
    add('getvalueforkey', { WFInput: attachment(configuration), WFDictionaryKey: key, WFGetDictionaryValueType: 'Value' }, original[index].WFWorkflowActionParameters.UUID);
  }
  actions.push(...original.slice(3));
  workflow.WFWorkflowName = 'Save to Crate (iOS 27)';
  workflow.WFWorkflowClientVersion = '5037.0.17';
  workflow.WFWorkflowMinimumClientVersion = 5000;
  workflow.WFWorkflowMinimumClientVersionString = '5000';
  workflow.WFWorkflowHasStoredValues = true;
  workflow.WFWorkflowImportQuestions = [];
  workflow.WFWorkflowActions = actions;
  return workflow;
}
