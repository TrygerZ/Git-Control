/**
 * Get started checklist derivation (P16).
 *
 * Pure: no `vscode`, no react, no DOM. The card component renders what these
 * functions answer, so every rule in PHASE_16 section 5.1 is decided here.
 */
export type StepId = 'connect' | 'commit' | 'publish' | 'pull-request';

export type StepState = 'done' | 'current' | 'todo' | 'na';

export type StepAction =
  | { kind: 'connect' }
  | { kind: 'publish' }
  | { kind: 'open-compare'; url: string }
  | { kind: 'create-pr' };

export interface OnboardingInput {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  hasRemote: boolean | null;
  github: { linked: boolean; connected: boolean; webUrl: string | null };
  pullRequests: ReadonlyArray<{ headRef: string; state: 'open' | 'closed' | 'merged' }> | null;
  createPrAvailable: boolean;
}

export interface OnboardingStep {
  id: StepId;
  state: StepState;
  action: StepAction | null;
}

export type CardPhase = 'hidden' | 'active' | 'done';

/** Returns `null` while the inputs are unknown, which hides the card. */
export function computeSteps(input: OnboardingInput): OnboardingStep[] | null {
  if (input.hasRemote === null) {
    return null;
  }

  const { github, branch } = input;
  const prApplies = github.linked && branch !== null;
  let pullRequests = input.pullRequests;
  if (prApplies && pullRequests === null) {
    // Private repository while signed out: the anonymous load failed, so treat
    // the unknown list as empty instead of hiding the card.
    if (github.connected) {
      return null;
    }
    pullRequests = [];
  }

  const prDone =
    pullRequests !== null &&
    branch !== null &&
    pullRequests.some(
      (pr) => pr.headRef === branch && (pr.state === 'open' || pr.state === 'merged'),
    );

  const defs: Array<{
    id: StepId;
    applies: boolean;
    done: boolean;
    action: StepAction | null;
  }> = [
    { id: 'connect', applies: github.linked, done: github.connected, action: { kind: 'connect' } },
    { id: 'commit', applies: true, done: input.head !== null, action: null },
    {
      id: 'publish',
      applies: input.hasRemote && branch !== null,
      done: input.upstream !== null,
      action: { kind: 'publish' },
    },
    {
      id: 'pull-request',
      applies: prApplies,
      done: prDone,
      action: input.createPrAvailable
        ? { kind: 'create-pr' }
        : compareAction(github.webUrl, branch),
    },
  ];

  let currentTaken = false;
  return defs.map((def) => {
    if (!def.applies) {
      return { id: def.id, state: 'na', action: null };
    }
    if (def.done) {
      return { id: def.id, state: 'done', action: null };
    }
    if (!currentTaken) {
      currentTaken = true;
      return { id: def.id, state: 'current', action: def.action };
    }
    return { id: def.id, state: 'todo', action: null };
  });
}

function compareAction(webUrl: string | null, branch: string | null): StepAction | null {
  const url = compareUrl(webUrl, branch);
  return url === null ? null : { kind: 'open-compare', url };
}

export function progress(steps: readonly OnboardingStep[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const step of steps) {
    if (step.state === 'na') {
      continue;
    }
    total += 1;
    if (step.state === 'done') {
      done += 1;
    }
  }
  return { done, total };
}

export function cardPhase(
  steps: readonly OnboardingStep[] | null,
  flags: { dismissed: boolean; sawIncomplete: boolean; forced: boolean },
): CardPhase {
  if (steps === null) {
    return 'hidden';
  }
  if (flags.dismissed && !flags.forced) {
    return 'hidden';
  }
  const allDone = steps.every((step) => step.state === 'done' || step.state === 'na');
  if (!allDone) {
    return 'active';
  }
  return flags.sawIncomplete || flags.forced ? 'done' : 'hidden';
}

/** `<webUrl>/compare/<branch>?expand=1`, or `null` when the inputs cannot form one. */
export function compareUrl(webUrl: string | null, branch: string | null): string | null {
  if (webUrl === null || branch === null || branch === '') {
    return null;
  }
  try {
    if (new URL(webUrl).protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }
  const base = webUrl.replace(/\/+$/, '');
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  return `${base}/compare/${encoded}?expand=1`;
}
