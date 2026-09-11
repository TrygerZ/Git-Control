/**
 * Contributors leaderboard panel in explorer sidebar.
 *
 * Renders a collapsible section with ranked commit authors, proportional
 * contribution bars, and interactive author selection filter.
 */
import { useEffect, useId, useMemo, useState, type JSX } from 'react';
import type { ContributorInfo } from '../messages';
import {
  contributorActionKind,
  contributorAvatarColor,
  contributorInitials,
  formatCount,
  isSafeImageSrc,
  resolveContributorAvatar,
  sanitizeGitText,
} from './format';
import { useT } from './useT';
import { useGitHubStore, useRepoStore, useSettingsStore } from './store';
import { Icon, Spinner } from './ui';

interface ContributorAvatarProps {
  name: string;
  email: string;
  avatarUrl: string | null | undefined;
}

function ContributorAvatar({ name, email, avatarUrl }: ContributorAvatarProps): JSX.Element {
  const [loadFailed, setLoadFailed] = useState(false);
  const initials = contributorInitials(name);
  const avatarColor = contributorAvatarColor(email);

  useEffect(() => {
    setLoadFailed(false);
  }, [avatarUrl]);

  const resolvedAvatar = resolveContributorAvatar(avatarUrl, loadFailed);

  if (resolvedAvatar !== null && isSafeImageSrc(resolvedAvatar)) {
    return (
      <span className="gc-contributors__avatar" aria-hidden="true">
        <img
          src={resolvedAvatar}
          alt={name}
          className="gc-contributors__avatar-img"
          loading="lazy"
          onError={() => setLoadFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="gc-contributors__avatar"
      style={{ backgroundColor: avatarColor }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Contributors(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const contributors = useRepoStore((s) => s.contributors);
  const contributorsLoading = useRepoStore((s) => s.contributorsLoading);
  const contributorsLoaded = useRepoStore((s) => s.contributorsLoaded);
  const contributorsExpanded = useRepoStore((s) => s.contributorsExpanded);
  const authorFilter = useRepoStore((s) => s.authorFilter);
  const contributorIdentities = useRepoStore((s) => s.contributorIdentities);
  const toggleContributorsExpanded = useRepoStore((s) => s.toggleContributorsExpanded);
  const setAuthorFilter = useRepoStore((s) => s.setAuthorFilter);
  const loadContributors = useRepoStore((s) => s.loadContributors);
  const loadContributorIdentity = useRepoStore((s) => s.loadContributorIdentity);
  const openUrl = useGitHubStore((s) => s.openUrl);

  const [showAll, setShowAll] = useState(false);
  const contentId = useId();

  useEffect(() => {
    if (contributorsExpanded && !contributorsLoaded && !contributorsLoading) {
      void loadContributors();
    }
  }, [contributorsExpanded, contributorsLoaded, contributorsLoading, loadContributors]);

  const totalCommits = useMemo(
    () => contributors.reduce((acc, c) => acc + c.count, 0),
    [contributors],
  );

  const maxCount = useMemo(
    () => (contributors.length > 0 && contributors[0] ? Math.max(1, contributors[0].count) : 1),
    [contributors],
  );

  const visibleContributors = useMemo(() => {
    if (showAll || contributors.length <= 10) return contributors;
    return contributors.slice(0, 10);
  }, [contributors, showAll]);

  useEffect(() => {
    if (!contributorsExpanded) return;
    for (const c of visibleContributors) {
      const email = c.email?.trim();
      if (email && contributorIdentities[email] === undefined) {
        void loadContributorIdentity(email);
      }
    }
  }, [contributorsExpanded, visibleContributors, contributorIdentities, loadContributorIdentity]);

  const handleContributorClick = async (c: ContributorInfo) => {
    const email = c.email?.trim();
    if (!email) {
      setAuthorFilter(authorFilter === c.email ? null : c.email);
      return;
    }
    let identity = contributorIdentities[email];
    if (identity === undefined) {
      identity = (await loadContributorIdentity(email)) ?? undefined;
    }
    if (identity?.htmlUrl) {
      await openUrl(identity.htmlUrl);
    } else {
      setAuthorFilter(authorFilter === c.email ? null : c.email);
    }
  };

  return (
    <section className="gc-contributors" aria-label={strings.contributors.panelAria}>
      <div className="gc-contributors__head">
        <button
          type="button"
          className="gc-contributors__toggle"
          onClick={toggleContributorsExpanded}
          aria-expanded={contributorsExpanded}
          aria-controls={contentId}
          aria-label={contributorsExpanded ? strings.contributors.collapseAria : strings.contributors.expandAria}
        >
          <span className="gc-contributors__chevron" aria-hidden="true">
            <Icon name={contributorsExpanded ? 'chevron-down' : 'chevron-right'} />
          </span>
          <span className="gc-contributors__title">{strings.contributors.sectionTitle}</span>
          {totalCommits > 0 && (
            <span className="gc-contributors__total">
              {strings.contributors.totalCommits(formatCount(totalCommits, language))}
            </span>
          )}
        </button>
      </div>

      {contributorsExpanded && (
        <div id={contentId} className="gc-contributors__content">
          {contributorsLoading && contributors.length === 0 ? (
            <div className="gc-contributors__loading">
              <Spinner label={strings.contributors.loading} />
            </div>
          ) : contributors.length === 0 ? (
            <p className="gc-contributors__empty">{strings.contributors.empty}</p>
          ) : (
            <>
              <ul className="gc-contributors__list" role="list">
                {visibleContributors.map((c) => {
                  const active = authorFilter === c.email;
                  const percent = Math.max(2, Math.round((c.count / maxCount) * 100));
                  const name = sanitizeGitText(c.name);
                  const countText = formatCount(c.count, language);
                  const email = c.email?.trim();
                  const identity = email ? contributorIdentities[email] : null;
                  const actionKind = contributorActionKind(c.email, identity);
                  const ariaLabel =
                    actionKind === 'profile'
                      ? strings.contributors.openProfileAria(name)
                      : active
                        ? strings.contributors.filterActiveAria(name)
                        : strings.contributors.filterInactiveAria(name);
                  return (
                    <li key={c.email || c.name} className="gc-contributors__row">
                      <button
                        type="button"
                        className={
                          active
                            ? 'gc-contributors__item gc-contributors__item--active'
                            : 'gc-contributors__item'
                        }
                        onClick={() => void handleContributorClick(c)}
                        aria-pressed={actionKind === 'profile' ? undefined : active}
                        aria-label={ariaLabel}
                      >
                        <ContributorAvatar
                          name={name}
                          email={c.email}
                          avatarUrl={identity?.avatarUrl}
                        />
                        <span className="gc-contributors__name" title={name}>
                          {name}
                        </span>
                        <span className="gc-contributors__bar-track" aria-hidden="true">
                          <span
                            className="gc-contributors__bar"
                            style={{ width: `${percent}%` }}
                          />
                        </span>
                        <span className="gc-contributors__count">{countText}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {contributors.length > 10 && (
                <button
                  type="button"
                  className="gc-button gc-button--quiet gc-contributors__more"
                  onClick={() => setShowAll(!showAll)}
                >
                  {showAll
                    ? strings.contributors.showLess
                    : strings.contributors.showAll(contributors.length)}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
