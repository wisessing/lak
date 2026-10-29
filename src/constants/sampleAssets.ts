/**
 * The bundled motion samples.
 *
 * These four files ship in `public/models` and are the built-in sample set:
 * one mannequin and four clips from Quaternius's Universal Animation Library
 * (Standard, CC0 1.0), split one clip per file. See the README.
 * They exist here as a typed manifest rather than as strings scattered through
 * the UI so that the picker, the empty state, and later the immersive panel all
 * offer exactly the same set, and so a missing file is a build-visible change
 * to one list.
 *
 * `url` is resolved against the app's base URL. The Vite config sets `base` to
 * `'./'`, so a hard-coded `/models/...` would break wherever the app is served
 * from a subdirectory.
 *
 * Metadata here is descriptive only. Nothing in the app depends on `seconds`
 * being exact, so a clip change cannot silently
 * mis-render — it only makes a label stale.
 */

export interface SampleAsset {
  /** Stable identity, used for request tracking and the active-sample mark. */
  id: string;
  /** Short name for a button. */
  label: string;
  /** One line on what this clip is useful for. */
  description: string;
  /** The name the asset takes once loaded, matching a user-picked file. */
  fileName: string;
  /** Approximate first-clip length, for the picker only. */
  seconds: number;
}

const FILES: Omit<SampleAsset, 'fileName'>[] = [
  {
    id: 'idle',
    label: 'Idle',
    description: 'A calm standing loop: the low-motion baseline.',
    seconds: 2.5,
  },
  {
    id: 'walk',
    label: 'Walk',
    description: 'One gait cycle, in place.',
    seconds: 1.33,
  },
  {
    id: 'punch',
    label: 'Punch',
    description: 'A fast cross: sharp arm and hand speeds.',
    seconds: 1,
  },
  {
    id: 'dance',
    label: 'Dance',
    description: 'A full-body dance loop: every limb at once.',
    seconds: 1,
  },
];

const FILE_NAMES: Record<string, string> = {
  idle: 'mannequin_idle.fbx',
  walk: 'mannequin_walk.fbx',
  punch: 'mannequin_punch.fbx',
  dance: 'mannequin_dance.fbx',
};

export const SAMPLE_ASSETS: SampleAsset[] = FILES.map((entry) => ({
  ...entry,
  fileName: FILE_NAMES[entry.id],
}));

/** The base-aware URL the sample is fetched from. */
export function sampleUrl(sample: SampleAsset): string {
  return `${import.meta.env.BASE_URL}models/${sample.fileName}`;
}

export function findSample(id: string): SampleAsset | undefined {
  return SAMPLE_ASSETS.find((s) => s.id === id);
}
