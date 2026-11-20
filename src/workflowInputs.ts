/**
 * Pure parser for GitHub Actions `on.workflow_dispatch.inputs` declarations and
 * workflow web URL builder (P27).
 *
 * Zero `vscode` and zero `node:` imports. Unsupported YAML shapes return `null`
 * so the caller falls back to input-free dispatch plus "Open on GitHub"
 * (D-P27-1) instead of guessing.
 */

import { validateInputName, validateInputValue } from './validation';

export type DispatchInputType = 'string' | 'boolean' | 'choice' | 'environment' | 'number';

export interface DispatchInput {
  name: string;
  description: string;
  required: boolean;
  type: DispatchInputType;
  default: string | null;
  options: string[];
}

interface Line {
  indent: number;
  content: string;
}

const MAX_INPUTS = 10;
const MAX_OPTIONS = 50;
const VALID_TYPES = new Set<DispatchInputType>(['string', 'boolean', 'choice', 'environment', 'number']);
const DOUBLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  r: '\r',
  t: '\t',
  '0': '\u0000',
};

function preprocessLines(yamlText: string): Line[] | null {
  const normalized = yamlText.replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n');
  const lines: Line[] = [];
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const wsMatch = /^[ \t]*/.exec(raw);
    const leadingWs = wsMatch ? wsMatch[0] : '';
    if (leadingWs.includes('\t')) return null;
    lines.push({
      indent: leadingWs.length,
      content: raw.slice(leadingWs.length),
    });
  }
  return lines;
}

function parseQuotedToken(
  raw: string,
  start: number,
  quote: "'" | '"',
): { value: string; nextIndex: number } | null {
  let out = '';
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, nextIndex: i + 1 };
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) return null;
      const mapped = DOUBLE_ESCAPES[next];
      if (mapped === undefined) return null;
      out += mapped;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: out, nextIndex: i + 1 };
    }
    out += ch;
    i += 1;
  }
  return null;
}

function stripInlineComment(raw: string): string {
  const trimmed = raw.trim();
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (trimmed[i + 1] === "'") {
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#' && (i === 0 || trimmed[i - 1] === ' ' || trimmed[i - 1] === '\t')) {
      return trimmed.slice(0, i).trimEnd();
    }
  }
  return trimmed;
}

function splitKeyValue(content: string): { key: string; rawValue: string } | null {
  if (content.length === 0) return null;
  const first = content[0]!;
  if (first === "'" || first === '"') {
    const token = parseQuotedToken(content, 0, first);
    if (!token) return null;
    if (content[token.nextIndex] !== ':') return null;
    const afterColon = content[token.nextIndex + 1];
    if (afterColon !== undefined && afterColon !== ' ' && afterColon !== '\t') return null;
    return {
      key: token.value,
      rawValue: content.slice(token.nextIndex + 1).trimStart(),
    };
  }

  if (first === '-' || first === '[' || first === '{' || first === '#' || first === '&' || first === '*' || first === '!' || first === '|' || first === '>') {
    return null;
  }

  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === ':') {
      const next = content[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        const key = content.slice(0, i).trimEnd();
        if (key.length === 0) return null;
        return {
          key,
          rawValue: content.slice(i + 1).trimStart(),
        };
      }
    }
  }
  return null;
}

function parseScalar(raw: string): { value: string; quoted: boolean } | null {
  const trimmed = raw.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return { value: '', quoted: false };
  }
  const first = trimmed[0]!;
  if (first === "'" || first === '"') {
    const token = parseQuotedToken(trimmed, 0, first);
    if (!token) return null;
    const rest = trimmed.slice(token.nextIndex).trim();
    if (rest.length > 0 && !rest.startsWith('#')) return null;
    return { value: token.value, quoted: true };
  }

  if (
    first === '|' ||
    first === '>' ||
    first === '&' ||
    first === '*' ||
    first === '!' ||
    first === '{' ||
    first === '['
  ) {
    return null;
  }

  return { value: stripInlineComment(trimmed), quoted: false };
}

function parseInlineOptions(raw: string): string[] | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('[')) return null;
  const items: string[] = [];
  let i = 1;

  const skipWs = (): void => {
    while (i < trimmed.length && (trimmed[i] === ' ' || trimmed[i] === '\t')) {
      i += 1;
    }
  };

  skipWs();
  if (trimmed[i] === ']') return null;

  while (i < trimmed.length) {
    skipWs();
    if (i >= trimmed.length) return null;
    const ch = trimmed[i]!;
    if (ch === "'" || ch === '"') {
      const token = parseQuotedToken(trimmed, i, ch);
      if (!token || !validateInputValue(token.value)) return null;
      items.push(token.value);
      i = token.nextIndex;
      skipWs();
    } else {
      if (ch === '[' || ch === '{' || ch === '}' || ch === '&' || ch === '*' || ch === '!' || ch === '|' || ch === '>') {
        return null;
      }
      const itemStart = i;
      while (i < trimmed.length && trimmed[i] !== ',' && trimmed[i] !== ']') {
        const cur = trimmed[i]!;
        if (cur === '[' || cur === '{' || cur === '}') return null;
        if (cur === '#' && (i === itemStart || trimmed[i - 1] === ' ' || trimmed[i - 1] === '\t')) {
          return null;
        }
        i += 1;
      }
      const unquoted = trimmed.slice(itemStart, i).trimEnd();
      if (unquoted.length === 0 || !validateInputValue(unquoted)) return null;
      items.push(unquoted);
    }

    if (items.length > MAX_OPTIONS) return null;
    const sep = trimmed[i];
    if (sep === ',') {
      i += 1;
      skipWs();
      if (i >= trimmed.length || trimmed[i] === ']') return null;
      continue;
    }
    if (sep === ']') {
      const rest = trimmed.slice(i + 1).trim();
      if (rest.length > 0 && !rest.startsWith('#')) return null;
      return items;
    }
    return null;
  }
  return null;
}

function collectBlock(lines: readonly Line[], start: number, parentIndent: number): number {
  let i = start;
  while (i < lines.length && lines[i]!.indent > parentIndent) {
    i += 1;
  }
  return i;
}

function parseBlockOptions(lines: readonly Line[], start: number, end: number): string[] | null {
  if (start >= end || end - start > MAX_OPTIONS) return null;
  const options: string[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i]!;
    if (line.indent !== 10 || !line.content.startsWith('- ')) return null;
    const scalar = parseScalar(line.content.slice(2));
    if (!scalar) return null;
    if (!scalar.quoted && scalar.value.length === 0) return null;
    if (!validateInputValue(scalar.value)) return null;
    options.push(scalar.value);
  }
  return options;
}

function parseSingleInput(
  name: string,
  lines: readonly Line[],
  start: number,
  end: number,
): DispatchInput | null {
  let description = '';
  let required = false;
  let type: DispatchInputType = 'string';
  let defaultValue: string | null = null;
  let options: string[] = [];
  const seenProps = new Set<string>();

  for (let i = start; i < end; ) {
    const line = lines[i]!;
    if (line.indent !== 8) return null;
    const kv = splitKeyValue(line.content);
    if (!kv || seenProps.has(kv.key)) return null;
    seenProps.add(kv.key);

    const childEnd = collectBlock(lines, i + 1, 8);
    if (kv.key === 'options') {
      const cleanVal = stripInlineComment(kv.rawValue);
      if (cleanVal.startsWith('[')) {
        if (childEnd !== i + 1) return null;
        const parsed = parseInlineOptions(kv.rawValue);
        if (!parsed) return null;
        options = parsed;
        i += 1;
      } else if (cleanVal.length === 0) {
        const parsed = parseBlockOptions(lines, i + 1, childEnd);
        if (!parsed) return null;
        options = parsed;
        i = childEnd;
      } else {
        return null;
      }
      continue;
    }

    if (childEnd !== i + 1) return null;
    const scalar = parseScalar(kv.rawValue);
    if (!scalar) return null;

    switch (kv.key) {
      case 'description':
        description = scalar.value;
        break;
      case 'required': {
        if (scalar.quoted) return null;
        const lower = scalar.value.toLowerCase();
        if (lower === 'true') required = true;
        else if (lower === 'false') required = false;
        else return null;
        break;
      }
      case 'type':
        if (!VALID_TYPES.has(scalar.value as DispatchInputType)) return null;
        type = scalar.value as DispatchInputType;
        break;
      case 'default': {
        const isUnquotedNull =
          !scalar.quoted &&
          (scalar.value === '' ||
            scalar.value === '~' ||
            scalar.value === 'null' ||
            scalar.value === 'Null' ||
            scalar.value === 'NULL');
        if (isUnquotedNull) {
          defaultValue = null;
        } else {
          if (!validateInputValue(scalar.value)) return null;
          defaultValue = scalar.value;
        }
        break;
      }
      default:
        return null;
    }
    i += 1;
  }

  if (type === 'choice' && options.length === 0) return null;
  if (type !== 'choice' && options.length > 0) return null;

  return {
    name,
    description,
    required,
    type,
    default: defaultValue,
    options,
  };
}

function parseInputsBlock(lines: readonly Line[], start: number, end: number): DispatchInput[] | null {
  const inputs: DispatchInput[] = [];
  const seenNames = new Set<string>();
  for (let i = start; i < end; ) {
    const line = lines[i]!;
    if (line.indent !== 6) return null;
    const kv = splitKeyValue(line.content);
    if (!kv || !validateInputName(kv.key) || seenNames.has(kv.key)) return null;
    seenNames.add(kv.key);
    if (inputs.length >= MAX_INPUTS) return null;

    const childEnd = collectBlock(lines, i + 1, 6);
    const cleanVal = stripInlineComment(kv.rawValue);
    if (cleanVal === '{}') {
      if (childEnd !== i + 1) return null;
      inputs.push({
        name: kv.key,
        description: '',
        required: false,
        type: 'string',
        default: null,
        options: [],
      });
      i += 1;
      continue;
    }
    if (cleanVal.length > 0) return null;

    const parsed = parseSingleInput(kv.key, lines, i + 1, childEnd);
    if (!parsed) return null;
    inputs.push(parsed);
    i = childEnd;
  }
  return inputs;
}

function parseWorkflowDispatchBlock(lines: readonly Line[], start: number, end: number): DispatchInput[] | null {
  let foundInputs = false;
  let result: DispatchInput[] = [];

  for (let i = start; i < end; ) {
    const line = lines[i]!;
    if (line.indent !== 4) return null;
    const kv = splitKeyValue(line.content);
    if (!kv) return null;
    const childEnd = collectBlock(lines, i + 1, 4);

    if (kv.key === 'inputs') {
      if (foundInputs) return null;
      foundInputs = true;
      const cleanVal = stripInlineComment(kv.rawValue);
      if (cleanVal === '{}') {
        if (childEnd !== i + 1) return null;
        result = [];
      } else if (cleanVal.length === 0) {
        const parsed = parseInputsBlock(lines, i + 1, childEnd);
        if (!parsed) return null;
        result = parsed;
      } else {
        return null;
      }
    }
    i = childEnd;
  }
  return result;
}

function parseOnBlock(lines: readonly Line[], start: number, end: number): DispatchInput[] | null {
  for (let i = start; i < end; i += 1) {
    if (lines[i]!.indent % 2 !== 0) return null;
  }
  if (start >= end) return [];

  const first = lines[start]!;
  if (first.indent === 2 && (first.content === '-' || first.content.startsWith('- '))) {
    for (let i = start; i < end; i += 1) {
      const line = lines[i]!;
      if (line.indent === 2 && line.content !== '-' && !line.content.startsWith('- ')) {
        return null;
      }
    }
    return [];
  }

  let foundDispatch = false;
  let result: DispatchInput[] = [];
  for (let i = start; i < end; ) {
    const line = lines[i]!;
    if (line.indent !== 2) return null;
    const kv = splitKeyValue(line.content);
    if (!kv) return null;
    const childEnd = collectBlock(lines, i + 1, 2);

    if (kv.key === 'workflow_dispatch') {
      if (foundDispatch) return null;
      foundDispatch = true;
      const cleanVal = stripInlineComment(kv.rawValue);
      if (cleanVal === '{}') {
        if (childEnd !== i + 1) return null;
        result = [];
      } else if (cleanVal.length === 0) {
        const parsed = parseWorkflowDispatchBlock(lines, i + 1, childEnd);
        if (!parsed) return null;
        result = parsed;
      } else {
        return null;
      }
    }
    i = childEnd;
  }
  return result;
}

/**
 * Parses `on.workflow_dispatch.inputs` from a GitHub Actions workflow YAML file.
 * Returns `[]` when `workflow_dispatch` or `inputs` is absent, or `null` when
 * the YAML uses unsupported constructs or violates validation bounds.
 */
export function parseDispatchInputs(yamlText: string): DispatchInput[] | null {
  const lines = preprocessLines(yamlText);
  if (!lines) return null;

  let onLineIndex = -1;
  let onRawValue = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.indent !== 0) continue;
    if (line.content === '---' || line.content === '...') continue;
    const kv = splitKeyValue(line.content);
    if (kv && kv.key === 'on') {
      if (onLineIndex !== -1) return null;
      onLineIndex = i;
      onRawValue = kv.rawValue;
    }
  }
  if (onLineIndex === -1) return [];

  const blockEnd = collectBlock(lines, onLineIndex + 1, 0);
  const cleanVal = stripInlineComment(onRawValue);
  if (cleanVal.length === 0) {
    return parseOnBlock(lines, onLineIndex + 1, blockEnd);
  }
  if (blockEnd !== onLineIndex + 1) return null;
  if (cleanVal.startsWith('[')) {
    return cleanVal.endsWith(']') ? [] : null;
  }
  const first = cleanVal[0]!;
  if (first === '{' || first === '&' || first === '*' || first === '!' || first === '|' || first === '>') {
    return null;
  }
  const scalar = parseScalar(onRawValue);
  return scalar ? [] : null;
}

const VALID_WEB_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Builds the HTTPS workflow page URL on GitHub or a GHE host, returning `null`
 * if the host is missing/unsafe or the workflow filename is invalid.
 */
export function workflowWebUrl(
  host: string | null,
  owner: string,
  repo: string,
  workflowPath: string,
): string | null {
  if (host === null || host.length === 0) return null;
  if (!VALID_WEB_HOST.test(host) || !host.includes('.')) return null;
  const segments = workflowPath.split('/');
  const file = segments[segments.length - 1] ?? '';
  if (file.length === 0 || file === '.' || file === '..') return null;
  if (CONTROL_CHARS.test(file)) return null;
  return `https://${host.toLowerCase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(file)}`;
}
