/**
 * Pull request filters, counts, grouping, and list key maths (P07).
 *
 * Pure by contract, like `route.ts`: no react, no DOM, no vscode. The chips,
 * the badge, and the list all read the same array, so every helper here takes
 * the array it will be compared against.
 */
import type { PullRequestInfo } from '../messages';

export type PrFilterId = 'open' | 'review-requested' | 'mine' | 'draft';

export interface PrContext {
  viewerLogin: string | null;
}

export interface PrGroups {
  needsReview: PullRequestInfo[];
  mine: PullRequestInfo[];
  other: PullRequestInfo[];
}

export const PR_PAGE_SIZE = 50;

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function wantsReview(pr: PullRequestInfo, viewer: string | null): boolean {
  if (viewer === null) return false;
  return pr.requestedReviewers.some((login) => sameLogin(login, viewer));
}

function authoredBy(pr: PullRequestInfo, viewer: string | null): boolean {
  return viewer !== null && sameLogin(pr.author, viewer);
}

export function filterPullRequests(
  prs: readonly PullRequestInfo[],
  filter: PrFilterId,
  ctx: PrContext,
): PullRequestInfo[] {
  const viewer = ctx.viewerLogin;
  switch (filter) {
    case 'open':
      return prs.filter((pr) => pr.state === 'open');
    case 'review-requested':
      return prs.filter((pr) => pr.state === 'open' && wantsReview(pr, viewer));
    case 'mine':
      return prs.filter((pr) => authoredBy(pr, viewer));
    case 'draft':
      return prs.filter((pr) => pr.draft);
  }
}

export function countByFilter(
  prs: readonly PullRequestInfo[],
  ctx: PrContext,
): Record<PrFilterId, number> {
  return {
    open: filterPullRequests(prs, 'open', ctx).length,
    'review-requested': filterPullRequests(prs, 'review-requested', ctx).length,
    mine: filterPullRequests(prs, 'mine', ctx).length,
    draft: filterPullRequests(prs, 'draft', ctx).length,
  };
}

export function matchesText(pr: PullRequestInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    pr.title.toLowerCase().includes(needle) ||
    pr.author.toLowerCase().includes(needle) ||
    pr.headRef.toLowerCase().includes(needle) ||
    pr.baseRef.toLowerCase().includes(needle) ||
    `#${pr.number}`.includes(needle) ||
    String(pr.number).includes(needle)
  );
}

export function groupPullRequests(prs: readonly PullRequestInfo[], ctx: PrContext): PrGroups {
  const viewer = ctx.viewerLogin;
  const needsReview: PullRequestInfo[] = [];
  const mine: PullRequestInfo[] = [];
  const other: PullRequestInfo[] = [];
  for (const pr of prs) {
    if (pr.state === 'open' && !pr.draft && wantsReview(pr, viewer)) {
      needsReview.push(pr);
    } else if (authoredBy(pr, viewer)) {
      mine.push(pr);
    } else {
      other.push(pr);
    }
  }
  return { needsReview, mine, other };
}

export function badgeCount(openCount: number, perPage: number): string | null {
  if (openCount < 1) return null;
  return openCount >= perPage ? `${perPage}+` : String(openCount);
}
