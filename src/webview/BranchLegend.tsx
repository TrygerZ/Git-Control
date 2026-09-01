/**
 * Legend: the teaching surface.
 *
 * Every glyph, dash pattern, line weight, and badge the canvas draws is explained
 * here in Indonesian — not as a key ("dashed = local") but as a short answer to
 * "what does this tell me, and what should I do about it?". Understanding git is
 * the point of this extension, so this panel is a feature, not a footnote.
 *
 * Rules held here: each swatch is built from the same CSS the canvas uses, so a
 * sample cannot drift from reality; every entry names at least two visual channels
 * (shape plus badge, weight plus curve), which is why the graph stays readable with
 * no colour at all.
 */
import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from 'react';
import { sanitizeGitText } from './format';
import { Icon } from './ui';
import { t, type Lang } from './i18n';
import { useT } from './useT';
import { useSettingsStore } from './store';
import type { GraphLane } from '../messages';

interface Props {
  lanes: readonly GraphLane[];
  id?: string;
  onClose?(): void;
}

/** Short display name for a lane's seed ref. Sanitised: refs come from git. */
export function laneLabel(lane: GraphLane, lang: Lang = 'en'): string {
  if (lane.ref === undefined) return t(lang).legend.laneDefault(lane.index + 1);
  const name = sanitizeGitText(lane.ref);
  if (name.startsWith('refs/tags/')) return t(lang).legend.laneTagPrefix(name.slice(10));
  if (name.startsWith('refs/remotes/')) return t(lang).legend.laneRemotePrefix(name.slice(13));
  if (name.startsWith('refs/heads/')) return name.slice(11);
  return name;
}

export function BranchLegend({ lanes, id, onClose }: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
    }
  };

  return (
    <section
      ref={panelRef}
      id={id}
      className="gc-legend"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="gc-legend__header">
        <h2 id={titleId} className="gc-legend__title">{strings.legend.title}</h2>
        {onClose !== undefined && (
          <button
            type="button"
            className="gc-icon-button gc-legend__close"
            aria-label={strings.legend.closeAria}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        )}
      </div>

      <div className="gc-legend__body">
        <p className="gc-legend__intro">
          {strings.legend.intro}
        </p>

        <h3 className="gc-legend__heading">{strings.legend.sectionCommitShapes}</h3>
        <dl className="gc-legend__list">
          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--head" aria-hidden="true" />
            {strings.legend.headTitle}
          </dt>
          <dd>
            {strings.legend.headDesc}
          </dd>

          <dt>
            <span className="gc-avatar gc-legend__avatar" aria-hidden="true">
              S
            </span>
            {strings.legend.initialTitle}
          </dt>
          <dd>
            {strings.legend.initialDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--remote" aria-hidden="true" />
            {strings.legend.remoteTitle}
          </dt>
          <dd>
            {strings.legend.remoteDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--local" aria-hidden="true" />
            {strings.legend.localTitle}
          </dt>
          <dd>
            {strings.legend.localDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--merge" aria-hidden="true" />
            {strings.legend.mergeTitle}
          </dt>
          <dd>
            {strings.legend.mergeDesc}
          </dd>
        </dl>

        <h3 className="gc-legend__heading">{strings.legend.sectionRefLabels}</h3>
        <dl className="gc-legend__list">
          <dt>
            <span className="gc-chip gc-chip--current"><Icon name="git-branch" /> main</span>
          </dt>
          <dd>
            {strings.legend.currentBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--local"><Icon name="circle-filled" /> fitur</span>
          </dt>
          <dd>
            {strings.legend.localBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--remote"><Icon name="cloud" /> origin/main</span>
          </dt>
          <dd>
            {strings.legend.remoteBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--tag"><Icon name="tag" /> v1.0</span>
          </dt>
          <dd>
            {strings.legend.tagDesc}
          </dd>
        </dl>

        {lanes.length > 0 && (
          <>
            <h3 className="gc-legend__heading">{strings.legend.sectionActiveLanes}</h3>
            <ul className="gc-legend__lanes">
              {lanes.map((lane) => (
                <li key={lane.index}>
                  <span
                    className="gc-legend__lane-color"
                    style={{ background: lane.color }}
                    aria-hidden="true"
                  />
                  <span>{laneLabel(lane, language)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="gc-legend__heading">{strings.legend.sectionShortcuts}</h3>
        <ul className="gc-legend__keys">
          <li><kbd>←</kbd> <kbd>→</kbd> {strings.legend.keyMoveCommit}</li>
          <li><kbd>↑</kbd> <kbd>↓</kbd> {strings.legend.keyMoveLane}</li>
          <li><kbd>Enter</kbd> {strings.legend.keyOpenDetail}</li>
          <li><kbd>+</kbd> <kbd>-</kbd> {strings.legend.keyZoom}</li>
        </ul>
      </div>
    </section>
  );
}
