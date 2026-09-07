/**
 * Contributors leaderboard panel in explorer sidebar.
 *
 * Renders a collapsible section with ranked commit authors, proportional
 * contribution bars, and interactive author selection filter.
 */
import { useEffect, useId, useMemo, useState, type JSX } from 'react';
import {
  contributorAvatarColor,
  contributorInitials,
  formatCount,
  sanitizeGitText,
} from './format';
import { useT } from './useT';
import { useRepoStore, useSettingsStore } from './store';
import { Icon, Spinner } from './ui';

export function Contributors(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const contributors = useRepoStore((s) => s.contributors);
  const contributorsLoading = useRepoStore((s) => s.contributorsLoading);
  const contributorsLoaded = useRepoStore((s) => s.contributorsLoaded);
  const contributorsExpanded = useRepoStore((s) => s.contributorsExpanded);
  const authorFilter = useRepoStore((s) => s.authorFilter);
  const toggleContributorsExpanded = useRepoStore((s) => s.toggleContributorsExpanded);
  const setAuthorFilter = useRepoStore((s) => s.setAuthorFilter);
  const loadContributors = useRepoStore((s) => s.loadContributors);

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
                  const initials = contributorInitials(c.name);
                  const avatarColor = contributorAvatarColor(c.email);
                  const countText = formatCount(c.count, language);
                  return (
                    <li key={c.email || c.name} className="gc-contributors__row">
                      <button
                        type="button"
                        className={
                          active
                            ? 'gc-contributors__item gc-contributors__item--active'
                            : 'gc-contributors__item'
                        }
                        onClick={() => setAuthorFilter(active ? null : c.email)}
                        aria-pressed={active}
                        aria-label={
                          active
                            ? strings.contributors.filterActiveAria(name)
                            : strings.contributors.filterInactiveAria(name)
                        }
                      >
                        <span
                          className="gc-contributors__avatar"
                          style={{ backgroundColor: avatarColor }}
                          aria-hidden="true"
                        >
                          {initials}
                        </span>
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
