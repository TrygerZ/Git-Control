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
import { useState, type JSX } from 'react';
import { sanitizeGitText } from './format';
import type { GraphLane } from '../messages';

interface Props {
  lanes: readonly GraphLane[];
}

/** Short display name for a lane's seed ref. Sanitised: refs come from git. */
function laneLabel(lane: GraphLane): string {
  if (lane.ref === undefined) return `Jalur ${lane.index + 1}`;
  return sanitizeGitText(lane.ref)
    .replace('refs/heads/', '')
    .replace('refs/remotes/', 'remote ')
    .replace('refs/tags/', 'tag ');
}

export function BranchLegend({ lanes }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = 'gc-legend-body';

  return (
    <section className="gc-legend" aria-label="Keterangan simbol grafik">
      <button
        type="button"
        className="gc-legend__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <span className="gc-legend__toggle-glyph" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>{open ? 'Sembunyikan panduan simbol' : 'Panduan simbol grafik'}</span>
      </button>

      {open && (
        <div className="gc-legend__body" id={bodyId}>
          <p className="gc-legend__intro">
            Grafik membaca dari kiri ke kanan (lama ke baru). Setiap bulatan adalah commit dan garis adalah hubungan induk-anak.
          </p>

          <h3 className="gc-legend__heading">Bentuk commit</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--head" aria-hidden="true" />
              HEAD: posisi aktif
            </dt>
            <dd>
              Cincin ganda. Commit yang sedang Anda buka saat ini.
            </dd>

            <dt>
              <span className="gc-avatar gc-legend__avatar" aria-hidden="true">
                S
              </span>
              Huruf inisial: penulis
            </dt>
            <dd>
              Inisial nama pembuat commit untuk memudahkan pemindaian visual cepat.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--remote" aria-hidden="true" />
              Bulatan penuh: di remote
            </dt>
            <dd>
              Commit sudah terunggah ke remote server.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--local" aria-hidden="true" />
              Garis putus-putus: lokal
            </dt>
            <dd>
              Commit baru ada di komputer ini, belum di-push ke remote.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--merge" aria-hidden="true" />
              Bulatan besar: merge
            </dt>
            <dd>
              Titik temu penggabungan dua branch.
            </dd>
          </dl>

          <h3 className="gc-legend__heading">Label ref</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-chip gc-chip--current">◆ main</span>
            </dt>
            <dd>
              Branch aktif saat ini.
            </dd>
            <dt>
              <span className="gc-chip gc-chip--local">● fitur</span>
            </dt>
            <dd>
              Branch lokal lainnya.
            </dd>
            <dt>
              <span className="gc-chip gc-chip--remote">☁ origin/main</span>
            </dt>
            <dd>
              Branch tracking di server remote.
            </dd>
            <dt>
              <span className="gc-chip gc-chip--tag">⚑ v1.0</span>
            </dt>
            <dd>
              Tag penanda rilis.
            </dd>
          </dl>

          {lanes.length > 0 && (
            <>
              <h3 className="gc-legend__heading">Jalur aktif</h3>
              <ul className="gc-legend__lanes">
                {lanes.map((lane) => (
                  <li key={lane.index}>
                    <span
                      className="gc-legend__lane-color"
                      style={{ background: lane.color }}
                      aria-hidden="true"
                    />
                    <span>{laneLabel(lane)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="gc-legend__heading">Pintasan keyboard</h3>
          <ul className="gc-legend__keys">
            <li><kbd>←</kbd> <kbd>→</kbd> Pindah commit</li>
            <li><kbd>↑</kbd> <kbd>↓</kbd> Pindah jalur</li>
            <li><kbd>Enter</kbd> Buka detail</li>
            <li><kbd>+</kbd> <kbd>-</kbd> Zoom</li>
          </ul>
        </div>
      )}
    </section>
  );
}
