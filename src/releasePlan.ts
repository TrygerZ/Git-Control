/**
 * Pure release planning helpers: semver tag suggestion, previous-tag lookup,
 * preview command list, publish readiness, and default release title.
 *
 * Zero vscode or node imports so this module is unit-testable in isolation and
 * safe to import from both extension host and webview.
 */
import {
  validateBranchName,
  validateHash,
  validateReleaseBody,
  validateReleaseTitle,
  validateRemoteName,
  validateTagName,
} from './validation';

export interface ReleaseForm {
  tag: string;
  target: string;
  title: string;
  notes: string;
  annotated: boolean;
  prerelease: boolean;
  remote: string;
}

export interface TagSuggestion {
  name: string;
  bump: 'major' | 'minor' | 'patch';
  reason: string;
}

const SEMVER_RE = /^(v?)(\d+)\.(\d+)\.(\d+)$/;
const BREAKING_SUBJECT_RE = /^\s*[a-zA-Z0-9_-]+(?:\([^)]*\))?!:|BREAKING CHANGE/;
const FEAT_SUBJECT_RE = /^\s*feat(?:\([^)]*\))?:/i;
const FIX_SUBJECT_RE = /^\s*fix(?:\([^)]*\))?:/i;

interface ParsedSemver {
  raw: string;
  prefix: string;
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(tag: string): ParsedSemver | null {
  const match = SEMVER_RE.exec(tag);
  if (match === null) return null;
  const major = Number(match[2]);
  const minor = Number(match[3]);
  const patch = Number(match[4]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { raw: tag, prefix: match[1] ?? '', major, minor, patch };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function highestSemver(tags: readonly string[], predicate: (parsed: ParsedSemver) => boolean): ParsedSemver | null {
  let best: ParsedSemver | null = null;
  for (const tag of tags) {
    const parsed = parseSemver(tag);
    if (parsed === null || !predicate(parsed)) continue;
    if (best === null || compareSemver(parsed, best) > 0) best = parsed;
  }
  return best;
}

/** Suggest the next semver tag and bump level from existing tags and commit subjects. */
export function suggestNextTag(
  tags: readonly string[],
  subjectsSince: readonly string[],
): TagSuggestion | null {
  const highest = highestSemver(tags, () => true);
  if (highest === null) return null;

  let breaking = 0;
  let feats = 0;
  let fixes = 0;
  for (const subject of subjectsSince) {
    if (BREAKING_SUBJECT_RE.test(subject)) breaking += 1;
    else if (FEAT_SUBJECT_RE.test(subject)) feats += 1;
    else if (FIX_SUBJECT_RE.test(subject)) fixes += 1;
  }

  let bump: TagSuggestion['bump'];
  let name: string;
  if (breaking > 0) {
    bump = 'major';
    name = `${highest.prefix}${highest.major + 1}.0.0`;
  } else if (feats > 0) {
    bump = 'minor';
    name = `${highest.prefix}${highest.major}.${highest.minor + 1}.0`;
  } else {
    bump = 'patch';
    name = `${highest.prefix}${highest.major}.${highest.minor}.${highest.patch + 1}`;
  }

  const parts: string[] = [];
  if (breaking > 0) parts.push(`${breaking} breaking`);
  if (feats > 0) parts.push(`${feats} feat`);
  if (fixes > 0) parts.push(`${fixes} fix`);
  const reason =
    parts.length > 0
      ? parts.join(', ')
      : subjectsSince.length > 0
        ? `${subjectsSince.length} commit${subjectsSince.length === 1 ? '' : 's'}`
        : 'no commits';

  return { name, bump, reason };
}

/** Find the highest semver tag before the given candidate tag name. */
export function previousTag(tags: readonly string[], name: string): string | null {
  const candidate = parseSemver(name);
  const match = highestSemver(tags, (parsed) =>
    candidate !== null ? compareSemver(parsed, candidate) < 0 : parsed.raw !== name,
  );
  return match === null ? null : match.raw;
}

/** Build the ordered command preview shown before creating a tag or release. */
export function releaseCommands(
  form: ReleaseForm,
  owner: string,
  repo: string,
  mode: 'tag' | 'release',
): string[] {
  const commands: string[] = [];
  if (form.annotated) {
    const message = (form.title.trim().length > 0 ? form.title : form.tag).replace(/"/g, '\\"');
    commands.push(`git tag -a ${form.tag} ${form.target} -m "${message}"`);
  } else {
    commands.push(`git tag ${form.tag} ${form.target}`);
  }
  const remote = form.remote.trim();
  if (remote.length > 0) {
    commands.push(`git push ${remote} refs/tags/${form.tag}:refs/tags/${form.tag}`);
  }
  if (mode === 'release') {
    commands.push(`POST /repos/${owner}/${repo}/releases`);
  }
  return commands;
}

/** True when GitHub is connected and every release form field satisfies host validation. */
export function canPublish(form: ReleaseForm, connected: boolean): boolean {
  return (
    connected === true &&
    validateTagName(form.tag) &&
    (validateHash(form.target) || validateBranchName(form.target)) &&
    validateReleaseTitle(form.title) &&
    validateReleaseBody(form.notes) &&
    validateRemoteName(form.remote)
  );
}

/** Derive a default release title from the tag name and optional first markdown line. */
export function defaultTitle(name: string, firstNoteLine: string | null): string {
  if (firstNoteLine === null) return name;
  const cleaned = firstNoteLine.trim().replace(/^[#\s]+/, '').trim();
  if (cleaned.length === 0) return name;
  return cleaned.startsWith(name) ? cleaned : `${name} - ${cleaned}`;
}
