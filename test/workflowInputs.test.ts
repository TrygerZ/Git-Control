import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDispatchInputs, workflowWebUrl } from '../src/workflowInputs';

// ------------------------------------------------------- parseDispatchInputs

test('empty text or workflow without workflow_dispatch returns empty array', () => {
  assert.deepEqual(parseDispatchInputs(''), []);
  assert.deepEqual(parseDispatchInputs('   \n# comment only\n'), []);
  assert.deepEqual(
    parseDispatchInputs(`name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
`),
    [],
  );
  assert.deepEqual(parseDispatchInputs('on: push\njobs: {}\n'), []);
  assert.deepEqual(parseDispatchInputs('on: [push, pull_request]\n'), []);
});

test('workflow_dispatch trigger without inputs block returns empty array', () => {
  assert.deepEqual(parseDispatchInputs('on: workflow_dispatch\n'), []);
  assert.deepEqual(parseDispatchInputs('on: [push, workflow_dispatch]\n'), []);
  assert.deepEqual(
    parseDispatchInputs(`on:
  - push
  - workflow_dispatch
`),
    [],
  );
  assert.deepEqual(
    parseDispatchInputs(`name: Manual
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  run:
    runs-on: ubuntu-latest
`),
    [],
  );
  assert.deepEqual(
    parseDispatchInputs(`on:
  workflow_dispatch: {}
`),
    [],
  );
  assert.deepEqual(
    parseDispatchInputs(`on:
  workflow_dispatch:
    inputs: {}
`),
    [],
  );
});

test('parses string, boolean, choice (inline and block options), environment, and number inputs', () => {
  const yaml = `name: Release
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Release version'
        required: true
        default: '2.8.0'
        type: string
      dry_run:
        description: "Dry run mode"
        required: false
        default: false
        type: boolean
      target:
        description: Target channel # inline comment
        required: true
        default: stable
        type: choice
        options: [stable, 'beta', "canary"]
      env_name:
        description: Target environment
        type: environment
      retries:
        default: 3
        type: number
      channel_block:
        type: choice
        options:
          - alpha
          - "beta # not comment"
`;
  const parsed = parseDispatchInputs(yaml);
  assert.deepEqual(parsed, [
    {
      name: 'version',
      description: 'Release version',
      required: true,
      type: 'string',
      default: '2.8.0',
      options: [],
    },
    {
      name: 'dry_run',
      description: 'Dry run mode',
      required: false,
      type: 'boolean',
      default: 'false',
      options: [],
    },
    {
      name: 'target',
      description: 'Target channel',
      required: true,
      type: 'choice',
      default: 'stable',
      options: ['stable', 'beta', 'canary'],
    },
    {
      name: 'env_name',
      description: 'Target environment',
      required: false,
      type: 'environment',
      default: null,
      options: [],
    },
    {
      name: 'retries',
      description: '',
      required: false,
      type: 'number',
      default: '3',
      options: [],
    },
    {
      name: 'channel_block',
      description: '',
      required: false,
      type: 'choice',
      default: null,
      options: ['alpha', 'beta # not comment'],
    },
  ]);
});

test('handles CRLF line endings, quoted booleans/nulls, and hashes inside tokens or quotes', () => {
  const yaml =
    'on:\r\n' +
    '  "workflow_dispatch":\r\n' +
    '    inputs:\r\n' +
    '      tag:\r\n' +
    "        description: 'Tag with # hash and ''escaped'' quote'\r\n" +
    '        default: null\r\n' +
    '      anchor_word:\r\n' +
    '        description: issue#123\r\n' +
    '        default: "true"\r\n' +
    '        type: string\r\n';
  const parsed = parseDispatchInputs(yaml);
  assert.deepEqual(parsed, [
    {
      name: 'tag',
      description: "Tag with # hash and 'escaped' quote",
      required: false,
      type: 'string',
      default: null,
      options: [],
    },
    {
      name: 'anchor_word',
      description: 'issue#123',
      required: false,
      type: 'string',
      default: 'true',
      options: [],
    },
  ]);
});

test('supports 10 inputs and 50 choice options at the boundary', () => {
  const tenInputs = Array.from(
    { length: 10 },
    (_, i) => `      in_${i}:\n        type: string`,
  ).join('\n');
  const parsedTen = parseDispatchInputs(`on:\n  workflow_dispatch:\n    inputs:\n${tenInputs}\n`);
  assert.equal(parsedTen?.length, 10);

  const fiftyOptions = Array.from({ length: 50 }, (_, i) => `          - opt-${i}`).join('\n');
  const parsedFifty = parseDispatchInputs(
    `on:\n  workflow_dispatch:\n    inputs:\n      pick:\n        type: choice\n        options:\n${fiftyOptions}\n`,
  );
  assert.equal(parsedFifty?.[0]?.options.length, 50);
});

test('rejects tabs, odd indentation, 11 inputs, >50 options, and hostile names by returning null', () => {
  assert.equal(
    parseDispatchInputs('on:\n\tworkflow_dispatch:\n\t\tinputs:\n\t\t\ta:\n\t\t\t\ttype: string\n'),
    null,
    'tab indentation',
  );
  assert.equal(
    parseDispatchInputs('on:\n   workflow_dispatch:\n     inputs:\n       a:\n         type: string\n'),
    null,
    'odd indentation',
  );

  const elevenInputs = Array.from(
    { length: 11 },
    (_, i) => `      in_${i}:\n        type: string`,
  ).join('\n');
  assert.equal(
    parseDispatchInputs(`on:\n  workflow_dispatch:\n    inputs:\n${elevenInputs}\n`),
    null,
    '11 inputs exceeds cap',
  );

  const fiftyOneOptions = Array.from({ length: 51 }, (_, i) => `          - opt-${i}`).join('\n');
  assert.equal(
    parseDispatchInputs(
      `on:\n  workflow_dispatch:\n    inputs:\n      pick:\n        type: choice\n        options:\n${fiftyOneOptions}\n`,
    ),
    null,
    '51 options exceeds cap',
  );

  for (const badName of ['1bad', '-flag', '__proto__', 'constructor', 'a'.repeat(101)]) {
    assert.equal(
      parseDispatchInputs(`on:\n  workflow_dispatch:\n    inputs:\n      ${badName}:\n        type: string\n`),
      null,
      `hostile input name: ${badName}`,
    );
  }
});

test('returns null on unreadable shapes, invalid types/booleans, anchors, block scalars, or duplicate inputs', () => {
  assert.equal(
    parseDispatchInputs('on: { workflow_dispatch: { inputs: { a: { type: string } } } }\n'),
    null,
    'flow mapping on:',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      ver:\n        description: |\n          multi\n'),
    null,
    'block scalar',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch: &anchor\n    inputs:\n      a:\n        type: string\n'),
    null,
    'YAML anchor',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      pick:\n        type: choice\n'),
    null,
    'choice without options',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      txt:\n        type: string\n        options: [a, b]\n'),
    null,
    'options on non-choice input',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      flag:\n        required: yes\n'),
    null,
    'invalid boolean for required',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      flag:\n        type: object\n'),
    null,
    'unsupported input type',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      a:\n        type: string\n      a:\n        type: boolean\n'),
    null,
    'duplicate input name',
  );
  assert.equal(
    parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice\n        options: ["ok", "bad\\0opt"]\n'),
    null,
    'inline choice option with NUL fails validateInputValue',
  );
  assert.equal(
    parseDispatchInputs(`on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice\n        options:\n          - "${'x'.repeat(1025)}"\n`),
    null,
    'block choice option exceeding 1024 chars fails validateInputValue',
  );
});

// ------------------------------------------------------------ workflowWebUrl

test('workflowWebUrl builds an encoded https workflow URL and returns null without a valid https host or file', () => {
  assert.equal(
    workflowWebUrl('github.com', 'TrygerZ', 'Git-Control', '.github/workflows/release.yml'),
    'https://github.com/TrygerZ/Git-Control/actions/workflows/release.yml',
  );
  assert.equal(
    workflowWebUrl('GHE.Example.com', 'my org', 'my repo', '.github/workflows/build & deploy.yaml'),
    'https://ghe.example.com/my%20org/my%20repo/actions/workflows/build%20%26%20deploy.yaml',
  );
  assert.equal(workflowWebUrl(null, 'o', 'r', '.github/workflows/ci.yml'), null);
  assert.equal(workflowWebUrl('', 'o', 'r', '.github/workflows/ci.yml'), null);
  assert.equal(workflowWebUrl('localhost', 'o', 'r', '.github/workflows/ci.yml'), null);
  assert.equal(workflowWebUrl('https://github.com', 'o', 'r', '.github/workflows/ci.yml'), null);
  assert.equal(workflowWebUrl('github.com', 'o', 'r', ''), null);
  assert.equal(workflowWebUrl('github.com', 'o', 'r', '.github/workflows/..'), null);
});
