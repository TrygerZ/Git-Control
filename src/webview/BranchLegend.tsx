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
        <span>{open ? 'Sembunyikan keterangan simbol' : 'Apa arti simbol di grafik?'}</span>
      </button>

      {open && (
        <div className="gc-legend__body" id={bodyId}>
          <p className="gc-legend__intro">
            Grafik ini membaca dari bawah ke atas: commit paling lama di bawah, paling baru di atas.
            Setiap bulatan adalah satu commit, dan setiap garis adalah hubungan induk—anak di antara
            dua commit.
          </p>

          <h3 className="gc-legend__heading">Bentuk commit</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--head" aria-hidden="true" />
              HEAD — posisi Anda
            </dt>
            <dd>
              Cincin ganda plus badge <strong>HEAD</strong>. Inilah commit yang sedang Anda tempati;
              commit berikutnya akan menempel persis di atasnya. Kalau badge ini jauh di bawah puncak
              sebuah branch, berarti Anda sedang tidak berada di ujung branch itu.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--remote" aria-hidden="true" />
              Bulatan penuh — sudah ada di remote
            </dt>
            <dd>
              Commit ini sudah terkirim ke remote, jadi rekan Anda bisa mengambilnya dan salinannya
              tidak hanya ada di komputer ini. Mengubah histori di bawah titik ini akan menyulitkan
              orang lain, karena mereka mungkin sudah memakainya.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--local" aria-hidden="true" />
              Bulatan kosong garis putus-putus — lokal, belum dipush
            </dt>
            <dd>
              Ditandai juga badge <strong>↑ lokal</strong>. Commit ini hanya ada di komputer Anda:
              belum ada cadangan di remote, dan belum ada yang bisa melihatnya. Push agar aman.
              Selama masih lokal, commit ini relatif murah untuk diubah atau disusun ulang.
            </dd>

            <dt>
              <span className="gc-legend__swatch gc-legend__swatch--merge" aria-hidden="true" />
              Bulatan besar bercincin — commit merge
            </dt>
            <dd>
              Ditandai juga badge <strong>⑃ merge</strong>. Commit ini punya dua induk atau lebih:
              dua jalur kerja yang tadinya berpisah bertemu di sini. Karena itu ia punya dua garis
              yang masuk dari bawah, bukan satu.
            </dd>
          </dl>

          <h3 className="gc-legend__heading">Garis penghubung</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-legend__line gc-legend__line--direct" aria-hidden="true" />
              Garis tipis — induk pertama
            </dt>
            <dd>
              Kelanjutan langsung: commit di atas dibuat tepat setelah commit di bawahnya, pada jalur
              yang sama. Ikuti garis tipis ke bawah untuk menelusuri sejarah utama sebuah branch.
            </dd>
            <dt>
              <span className="gc-legend__line gc-legend__line--merge" aria-hidden="true" />
              Garis tebal melengkung — induk kedua
            </dt>
            <dd>
              Hubungan merge: kerja dari jalur lain masuk ke jalur ini. Garisnya sengaja hampir dua
              kali lebih tebal dan melengkung menyeberangi jalur, supaya titik penggabungan terlihat
              sekilas tanpa perlu melihat warna.
            </dd>
          </dl>

          <h3 className="gc-legend__heading">Label ref</h3>
          <dl className="gc-legend__list">
            <dt>
              <span className="gc-chip gc-chip--current">◆ main</span>
            </dt>
            <dd>
              Branch yang sedang aktif — belah ketupat, garis tepi warna fokus, dan tulisan tebal.
              Commit baru akan menambah panjang branch inilah.
            </dd>
            <dt>
              <span className="gc-chip gc-chip--local">● fitur</span>
            </dt>
            <dd>
              Branch lokal lain. Ada di komputer Anda tapi bukan yang sedang Anda tempati; pindah ke
              sana lewat menu tindakan pada commit.
            </dd>
            <dt>
              <span className="gc-chip gc-chip--remote">☁ origin/main</span>
            </dt>
            <dd>
              Branch di remote, ditandai glyph awan, garis tepi putus-putus, dan awalan nama remote.
              Jarak antara chip ini dan branch lokal senama adalah jumlah commit yang belum Anda push
              atau belum Anda ambil.
            </dd>
            <dt>
              <span className="gc-chip gc-chip--tag">⚑ v1.0</span>
            </dt>
            <dd>
              Tag: penanda tetap pada satu commit, biasanya sebuah rilis. Bentuknya kotak, bukan
              kapsul, karena tag tidak bergerak mengikuti commit baru seperti branch.
            </dd>
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
                Warna jalur hanya alat bantu untuk mengikuti satu branch dengan mata, dan warnanya
                bisa berubah saat histori dimuat lebih banyak. Setiap keadaan commit selalu punya
                bentuk, ketebalan garis, atau badge sendiri, jadi grafik tetap terbaca pada tema
                kontras tinggi maupun tanpa warna.
              </p>
            </>
          )}

          <h3 className="gc-legend__heading">Papan tombol</h3>
          <ul className="gc-legend__keys">
            <li>
              <kbd>↑</kbd> <kbd>↓</kbd> pindah pilihan commit
            </li>
            <li>
              <kbd>←</kbd> <kbd>→</kbd> geser kanvas ke kiri / kanan
            </li>
            <li>
              <kbd>PageUp</kbd> <kbd>PageDown</kbd> pindah satu layar
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
              <kbd>+</kbd> <kbd>-</kbd> perbesar / perkecil, <kbd>0</kbd> kembali ke 100%
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
