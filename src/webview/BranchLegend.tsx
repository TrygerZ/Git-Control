/**
 * Legend: the teaching surface. Every glyph, dash pattern, and badge used by the
 * canvas is explained here in Indonesian, because "understand your git" is the
 * point of the extension — not decoration.
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

  return (
    <section className="gc-legend" aria-label="Keterangan simbol grafik">
      <button
        type="button"
        className="gc-legend__toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Sembunyikan keterangan' : 'Tampilkan keterangan'}
      </button>

      {open && (
        <div className="gc-legend__body">
          <h3 className="gc-legend__heading">Bentuk commit</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--head" aria-hidden="true" />
              HEAD
            </dt>
            <dd>
              Cincin ganda plus badge <strong>HEAD</strong>. Ini posisi Anda sekarang — commit
              berikutnya akan menempel di sini.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--remote" aria-hidden="true" />
              Sudah ada di remote
            </dt>
            <dd>
              Bulatan penuh. Commit sudah terkirim, jadi orang lain sudah bisa melihatnya.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--local" aria-hidden="true" />
              Lokal, belum dipush
            </dt>
            <dd>
              Garis putus-putus plus badge <strong>↑</strong>. Commit hanya ada di komputer Anda.
              Push agar tidak hilang bila perangkat bermasalah.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--merge" aria-hidden="true" />
              Commit merge
            </dt>
            <dd>
              Bulatan lebih besar dengan cincin tambahan. Commit ini punya dua induk: dua jalur
              kerja bertemu di sini.
            </dd>
          </dl>

          <h3 className="gc-legend__heading">Garis penghubung</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-legend__line gc-legend__line--direct" aria-hidden="true" />
              Garis lurus
            </dt>
            <dd>Hubungan induk pertama: kelanjutan langsung dari commit di bawahnya.</dd>
            <dt>
              <span className="gc-legend__line gc-legend__line--merge" aria-hidden="true" />
              Garis melengkung tebal
            </dt>
            <dd>Hubungan merge: induk kedua dan seterusnya, biasanya dari jalur lain.</dd>
          </dl>

          <h3 className="gc-legend__heading">Label ref</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-chip gc-chip--current">◆ main</span>
            </dt>
            <dd>Branch aktif. Ditandai belah ketupat dan diberi tekanan visual utama.</dd>
            <dt>
              <span className="gc-chip gc-chip--local">● fitur</span>
            </dt>
            <dd>Branch lokal lain.</dd>
            <dt>
              <span className="gc-chip gc-chip--remote">☁ origin/main</span>
            </dt>
            <dd>Branch di remote. Dibedakan lewat glyph awan dan awalan nama remote.</dd>
            <dt>
              <span className="gc-chip gc-chip--tag">⚑ v1.0</span>
            </dt>
            <dd>Tag: penanda tetap pada satu commit.</dd>
          </dl>

          {lanes.length > 0 && (
            <>
              <h3 className="gc-legend__heading">Jalur yang sedang tampil</h3>
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
              <p className="gc-legend__note">
                Warna jalur hanya alat bantu. Setiap keadaan commit juga punya bentuk, garis, atau
                badge sendiri sehingga tetap terbaca tanpa warna.
              </p>
            </>
          )}

          <h3 className="gc-legend__heading">Papan tombol</h3>
          <ul className="gc-legend__keys">
            <li>
              <kbd>↑</kbd> <kbd>↓</kbd> pindah pilihan commit
            </li>
            <li>
              <kbd>Home</kbd> <kbd>End</kbd> ke commit terbaru / terlama
            </li>
            <li>
              <kbd>Enter</kbd> buka detail commit
            </li>
            <li>
              <kbd>Shift</kbd>+<kbd>F10</kbd> buka menu tindakan
            </li>
            <li>
              <kbd>+</kbd> <kbd>-</kbd> perbesar / perkecil
            </li>
            <li>
              <kbd>Space</kbd>+geser tetikus untuk menggeser kanvas
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}
