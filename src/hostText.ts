import type { Lang } from './messages';

const en = {
  guard: {
    dirty: 'Commit or stash changes before checkout.',
    conflictInProgress: 'Resolve in-progress git operation first.',
    conflictFiles: 'Resolve all conflicted files.',
    stale: 'Remote status is stale.',
    remoteAhead: 'Remote has different history.',
    nonFastForward: 'Push is not fast-forward.',
    resetHard: 'Hard reset discards changes permanently.',
    confirm: 'This action requires confirmation.',
  },
  bridge: {
    noRepository: 'This folder is not a Git repository.',
    notFound: 'Data not found.',
    invalid: 'Invalid request.',
    locked: 'Repository is locked by another git process.',
    hookRejected: 'Commit rejected by git hook.',
    nonFastForward: 'Push is not fast-forward.',
    confirmationRequired: 'This action requires confirmation.',
    staleToken: 'Status changed, reload before continuing.',
    commitPushFailed: 'Commit succeeded, push failed.',
    unavailable: 'Service unavailable.',
    githubPending: 'GitHub integration is not available.',
    timeout: 'Git operation timed out.',
    diffUnavailable: 'Opening diff is not available on this host.',
    diffBinary: 'Text diff is unavailable for binary files.',
    externalBlocked: 'This link cannot be opened.',
    outputTooLarge: 'Git output is too large to display.',
  },
  layout: {
    unknownDate: 'Unknown date',
  },
  github: {
    invalidToken: 'Invalid GitHub token.',
    notFound: 'GitHub repository not available.',
    unavailable: 'GitHub is unreachable.',
    rateLimited: 'GitHub request limit reached.',
    forbidden: 'GitHub access denied.',
    scopeMissing: 'Token lacks repo:status scope for private repository.',
    invalidHash: 'Invalid commit hash.',
  },
  extension: {
    gitMissing: 'Git was not found on PATH.',
    gitMissingAction: 'Install instructions',
    gitPathRelative: 'Git path must be an absolute path.',
    notARepo: 'This folder is not a Git repository.',
    pickFolder: 'Pick folder',
    pickRepo: 'Pick repository',
    noFolder: 'Open a folder first.',
    githubConnected: 'GitHub connected.',
    githubDisconnected: 'GitHub disconnected.',
    githubPrompt: 'Paste GitHub Personal Access Token',
    refreshed: 'Git Control refreshed.',
    diffTrimmed: 'Diff trimmed for performance.',
    diffBinary: 'Text diff is unavailable for binary files.',
    githubUntrustedBase:
      'Token not sent: API address comes from remote URL, not from your settings. ' +
      'Set gitControl.githubApiUrl if this host is indeed your GitHub Enterprise.',
  },
};

export type HostCatalog = typeof en;

const id: HostCatalog = {
  guard: {
    dirty: 'Commit atau stash perubahan sebelum checkout.',
    conflictInProgress: 'Selesaikan operasi git yang sedang berjalan.',
    conflictFiles: 'Selesaikan semua file konflik.',
    stale: 'Status remote kedaluwarsa.',
    remoteAhead: 'Remote memiliki histori berbeda.',
    nonFastForward: 'Push bukan fast-forward.',
    resetHard: 'Hard reset membuang perubahan permanen.',
    confirm: 'Tindakan ini perlu konfirmasi.',
  },
  bridge: {
    noRepository: 'Folder ini bukan repository Git.',
    notFound: 'Data tidak ditemukan.',
    invalid: 'Permintaan tidak valid.',
    locked: 'Repository sedang dipakai proses git lain.',
    hookRejected: 'Commit ditolak oleh git hook.',
    nonFastForward: 'Push bukan fast-forward.',
    confirmationRequired: 'Tindakan ini perlu konfirmasi.',
    staleToken: 'Status berubah, muat ulang sebelum melanjutkan.',
    commitPushFailed: 'Commit berhasil, push gagal.',
    unavailable: 'Layanan tidak tersedia.',
    githubPending: 'Integrasi GitHub belum tersedia.',
    timeout: 'Operasi git melebihi batas waktu.',
    diffUnavailable: 'Membuka diff tidak tersedia pada host ini.',
    diffBinary: 'Diff teks tidak tersedia untuk file binary.',
    externalBlocked: 'Tautan ini tidak boleh dibuka.',
    outputTooLarge: 'Keluaran git terlalu besar untuk ditampilkan.',
  },
  layout: {
    unknownDate: 'Tanggal tidak diketahui',
  },
  github: {
    invalidToken: 'Token GitHub tidak valid.',
    notFound: 'Repository GitHub tidak tersedia.',
    unavailable: 'GitHub tidak dapat dijangkau.',
    rateLimited: 'Batas permintaan GitHub tercapai.',
    forbidden: 'Akses GitHub ditolak.',
    scopeMissing: 'Token tidak punya scope repo:status untuk repository privat.',
    invalidHash: 'Hash commit tidak valid.',
  },
  extension: {
    gitMissing: 'Git tidak ditemukan pada PATH.',
    gitMissingAction: 'Petunjuk instalasi',
    gitPathRelative: 'Lokasi path git harus berupa path absolut.',
    notARepo: 'Folder ini bukan repository Git.',
    pickFolder: 'Pilih folder',
    pickRepo: 'Pilih repository',
    noFolder: 'Buka folder terlebih dahulu.',
    githubConnected: 'GitHub tersambung.',
    githubDisconnected: 'GitHub diputus.',
    githubPrompt: 'Tempel Personal Access Token GitHub',
    refreshed: 'Git Control dimuat ulang.',
    diffTrimmed: 'Diff dipangkas demi performa.',
    diffBinary: 'Diff teks tidak tersedia untuk file binary.',
    githubUntrustedBase:
      'Token tidak dikirim: alamat API berasal dari URL remote, bukan dari setelan Anda. ' +
      'Setel gitControl.githubApiUrl bila host ini memang GitHub Enterprise Anda.',
  },
};

export const hostCatalogs: Record<Lang, HostCatalog> = { en, id };

export function hostText(lang: Lang): HostCatalog {
  return hostCatalogs[lang] ?? hostCatalogs.en;
}
