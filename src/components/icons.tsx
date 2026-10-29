import type { ReactNode } from 'react';

/**
 * Hand-drawn icon set — no icon dependency.
 *
 * Every glyph is authored in the same 24-unit box with a 1.75 stroke and round
 * caps/joins, so they sit together without drifting. Filled shapes are the
 * exception, not the rule: only the transport glyphs (play/pause/stop) are
 * solid, because a hollow play triangle reads as an outline button rather than
 * a control.
 *
 * `currentColor` throughout, so colour comes from the button that hosts it.
 */

interface IconProps {
  /** Pixel size; 16 suits inline buttons, 18 a toolbar, 14 dense rows. */
  size?: number;
  className?: string;
}

function Icon({
  size = 16,
  className,
  filled = false,
  children,
}: IconProps & { filled?: boolean; children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ---- File ------------------------------------------------- */

export const FolderOpenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8V6a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v1" />
    <path d="M3 8h17.2a1 1 0 0 1 .97 1.24l-1.8 8A1 1 0 0 1 18.4 18H5.6a1 1 0 0 1-.98-.8L3 8Z" />
  </Icon>
);

/** Import: an arrow coming down into a tray. Mirrors ExportIcon deliberately —
 * the two file operations should read as opposites. */
export const ImportIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11" />
    <path d="m8 11 4 4 4-4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Icon>
);

/** AR Mode on a phone: a headset, front on, with the nose bridge cut out of
 * its lower edge and the strap stubs at the sides. */
export const HeadsetIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8h16a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 17h-4.5l-1.8-2.4a2.1 2.1 0 0 0-3.4 0L8.5 17H4a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 4 8Z" />
    <path d="M2.5 11.5H1M21.5 11.5H23" />
  </Icon>
);

/** Hamburger, for the dock drawer toggle on narrow screens. */
export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const ExportIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V4" />
    <path d="m8 8 4-4 4 4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Icon>
);

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
    <path d="M10 11v6M14 11v6" />
  </Icon>
);

/* ---- Display toggles -------------------------------------- */

export const BoneIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.5 15.5 15.5 8.5" />
    <path d="M6.8 13.8a2.4 2.4 0 1 0-2.6 3.9 2.4 2.4 0 1 0 3.9-2.6" />
    <path d="M17.2 10.2a2.4 2.4 0 1 0 2.6-3.9 2.4 2.4 0 1 0-3.9 2.6" />
  </Icon>
);

export const MeshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="M12 3v18" />
    <path d="M4 7.5l8 4.5 8-4.5" />
  </Icon>
);

export const GridIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h18M12 3v18" />
    <path d="M3 7.5h18M3 16.5h18M7.5 3v18M16.5 3v18" opacity="0.45" />
  </Icon>
);

export const OnionIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6h9v9H6z" opacity="0.35" />
    <path d="M9 9h9v9H9z" />
  </Icon>
);

export const TrailIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 15c3 0 4.5-6 7.5-6s4.5 6 7.5 6c1.5 0 2.4-1.5 3-3" />
    <circle cx="18.5" cy="15" r="1.6" fill="currentColor" stroke="none" />
  </Icon>
);

/* ---- Transport (filled: these are controls, not outlines) -- */

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} filled>
    <path d="M8 5.5v13l11-6.5L8 5.5Z" />
  </Icon>
);

export const PlayBackIcon = (p: IconProps) => (
  <Icon {...p} filled>
    <path d="M16 5.5v13L5 12 16 5.5Z" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p} filled>
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
  </Icon>
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p} filled>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Icon>
);

export const StepForwardIcon = (p: IconProps) => (
  <Icon {...p} filled>
    <path d="M16.5 5.5h2.5v13h-2.5zM5 5.5 14.5 12 5 18.5V5.5Z" />
  </Icon>
);

export const StepBackIcon = (p: IconProps) => (
  <Icon {...p} filled>
    <path d="M5 5.5h2.5v13H5zM19 5.5 9.5 12 19 18.5V5.5Z" />
  </Icon>
);

/* ---- Editing ---------------------------------------------- */

export const ScissorsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="6.5" cy="6.5" r="2.5" />
    <path d="M8.6 8.6 20 20M20 4 8.6 15.4" />
  </Icon>
);

export const RevertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12a8 8 0 1 0 8-8 8.7 8.7 0 0 0-6 2.4L4 8" />
    <path d="M4 4v4.5h4.5" />
  </Icon>
);

export const MarkInIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4v16" />
    <path d="M20 12H11" />
    <path d="m14 8-3 4 3 4" />
  </Icon>
);

export const MarkOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 4v16" />
    <path d="M4 12h9" />
    <path d="m10 8 3 4-3 4" />
  </Icon>
);

/* ---- Chrome ----------------------------------------------- */

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 14.5 6-6 6 6" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" />
  </Icon>
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4M12 16.8v.2" />
  </Icon>
);

export const KeyboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8" />
  </Icon>
);

export const PanelIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M14 4v16" />
  </Icon>
);

/** A ring with a centre mark: aim, re-aim, place. */
export const TargetIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </Icon>
);
