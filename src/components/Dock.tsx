import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { getIsModified } from '../store/derive';
import type { BoneData } from '../types';
import {
  BoneIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GridIcon,
  MeshIcon,
  OnionIcon,
  RevertIcon,
  TrailIcon,
  TrashIcon,
} from './icons';
import { NavigationHelp } from './NavigationHelp';
import { SamplePicker } from './SamplePicker';
import './Dock.css';

/**
 * The right dock — the extension point of the shell.
 *
 * A new feature becomes a tab here rather than another floating panel, which is
 * the structural fix for how this UI grew. Analysis returns as a third tab.
 */

/**
 * One hierarchy row: a caret that expands, and a name that selects.
 *
 * Two controls, not one. The old row toggled expansion wherever you pressed,
 * so there was nothing to press *for* the joint itself. Selecting and
 * expanding are now separate targets, which is also what lets each reach the
 * touch minimum without overlapping the other.
 */
const BoneRow = ({ bone, level = 0 }: { bone: BoneData; level?: number }) => {
  const [expanded, setExpanded] = useState(level < 2);
  // The selection that was current when the user last collapsed this row.
  // Lets a collapse stick until the selection changes, without an effect.
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  const hasChildren = bone.children && bone.children.length > 0;
  const selectedJointId = useStore((s) => s.selectedJointId);
  const selectJoint = useStore((s) => s.selectJoint);
  const clearSelection = useStore((s) => s.clearSelection);
  const selected = selectedJointId === bone.id;

  /*
   * A selection made in the viewport has to be visible in the tree, or the
   * two halves of the feature disagree about what is selected. So a row whose
   * subtree contains the selection is open, unless the user collapsed it while
   * this same joint was selected. Derived, not synchronised: writing state
   * from an effect to follow another piece of state is how trees get out of
   * step.
   */
  const containsSelection =
    selectedJointId !== null && !selected && subtreeContains(bone, selectedJointId);
  const open = expanded || (containsSelection && collapsedFor !== selectedJointId);

  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className="bone-row">
      <div
        ref={rowRef}
        className={`bone-label ${hasChildren ? 'has-children' : ''} ${selected ? 'is-selected' : ''}`}
        style={{ paddingLeft: `${4 + level * 11}px` }}
      >
        {hasChildren ? (
          <button
            className="bone-caret"
            onClick={() => {
              if (open) setCollapsedFor(selectedJointId);
              setExpanded(!open);
            }}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${bone.name}`}
          >
            {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </button>
        ) : (
          <span className="bone-caret" aria-hidden="true" />
        )}
        <button
          className="bone-name"
          onClick={() => (selected ? clearSelection() : selectJoint(bone.id))}
          aria-pressed={selected}
          title={bone.name}
        >
          {bone.name || 'Unnamed bone'}
        </button>
      </div>

      {open && hasChildren && (
        <div className="bone-children">
          {bone.children.map((child) => (
            <BoneRow key={child.id} bone={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

/** Whether `id` names a joint anywhere below `bone`. */
function subtreeContains(bone: BoneData, id: string): boolean {
  return bone.children.some((c) => c.id === id || subtreeContains(c, id));
}

/** The display name for a joint identity, searching the hierarchy. */
function findBoneName(bones: BoneData[], id: string): string | null {
  for (const bone of bones) {
    if (bone.id === id) return bone.name;
    const found = findBoneName(bone.children, id);
    if (found) return found;
  }
  return null;
}

/** A display toggle: icon, label, and a checkbox affordance. */
function ToggleRow({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={`toggle-row ${checked ? 'is-on' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-icon">{icon}</span>
      <span className="toggle-text">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

export function Dock() {
  const [samplesOpen, setSamplesOpen] = useState(true);
  const dockTab = useStore((s) => s.dockTab);
  const setDockTab = useStore((s) => s.setDockTab);

  const fileName = useStore((s) => s.fileName);
  const skeleton = useStore((s) => s.skeleton);
  const sourceFormat = useStore((s) => s.sourceFormat);
  const requestClearModel = useStore((s) => s.requestClearModel);
  const revertToSource = useStore((s) => s.revertToSource);
  const applied = useStore((s) => s.applied);
  const sourceClip = useStore((s) => s.sourceClip);
  const isModified = getIsModified({ applied, sourceClip });

  const navHelpOpen = useStore((s) => s.navHelpOpen);
  const toggleNavHelp = useStore((s) => s.toggleNavHelp);

  const selectedJointId = useStore((s) => s.selectedJointId);
  const clearSelection = useStore((s) => s.clearSelection);
  const selectedJointName = selectedJointId
    ? findBoneName(skeleton?.bones ?? [], selectedJointId)
    : null;

  const showMesh = useStore((s) => s.showMesh);
  const showSkeleton = useStore((s) => s.showSkeleton);
  const showGrid = useStore((s) => s.showGrid);
  const showOnionSkin = useStore((s) => s.showOnionSkin);
  const showMotionTrail = useStore((s) => s.showMotionTrail);
  const toggleMesh = useStore((s) => s.toggleMesh);
  const toggleSkeleton = useStore((s) => s.toggleSkeleton);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const toggleOnionSkin = useStore((s) => s.toggleOnionSkin);
  const toggleMotionTrail = useStore((s) => s.toggleMotionTrail);

  return (
    <aside className="dock">
      <div className="dock-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={dockTab === 'scene'}
          className={`dock-tab ${dockTab === 'scene' ? 'is-active' : ''}`}
          onClick={() => setDockTab('scene')}
        >
          Scene
        </button>
        <button
          role="tab"
          aria-selected={dockTab === 'display'}
          className={`dock-tab ${dockTab === 'display' ? 'is-active' : ''}`}
          onClick={() => setDockTab('display')}
        >
          Display
        </button>
      </div>

      <div className="dock-body">
        {dockTab === 'scene' && (
          <>
            <section className="dock-section">
              <div className="dock-section-head">
                <span className="section-label">Asset</span>
                {fileName && (
                  <button
                    className="btn-icon"
                    onClick={requestClearModel}
                    aria-label="Clear model"
                    title="Clear model"
                  >
                    <TrashIcon size={14} />
                  </button>
                )}
              </div>

              {fileName ? (
                <>
                  <div className="asset-name" title={fileName}>{fileName}</div>
                  <div className="asset-meta">
                    {sourceFormat?.toUpperCase()}
                    {skeleton && ` · ${skeleton.boneCount} bones`}
                  </div>
                  {isModified && (
                    <button className="btn" onClick={revertToSource} title="Discard the applied edit">
                      <RevertIcon size={14} />
                      Revert to original
                    </button>
                  )}
                </>
              ) : (
                <p className="hint">No file loaded.</p>
              )}
            </section>

            {/* The samples stay reachable after the first load, so switching
                between them is not a clear-then-reload round trip. Collapsible
                because on a short landscape tablet the dock has to hold the
                asset, the samples, the help and the hierarchy at once. */}
            <section className="dock-section">
              <button
                className="section-toggle"
                onClick={() => setSamplesOpen(!samplesOpen)}
                aria-expanded={samplesOpen}
              >
                {samplesOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                <span className="section-label">Samples</span>
              </button>
              {samplesOpen && <SamplePicker variant="dock" />}
            </section>

            <section className="dock-section">
              {navHelpOpen ? (
                <NavigationHelp onDismiss={toggleNavHelp} />
              ) : (
                <button className="btn btn-ghost" onClick={toggleNavHelp}>
                  Camera help
                </button>
              )}
            </section>

            {skeleton && (
              <section className="dock-section dock-section-grow">
                <div className="dock-section-head">
                  <span className="section-label">Skeleton</span>
                  {selectedJointId && (
                    <button className="btn btn-ghost" onClick={clearSelection}>
                      Clear selection
                    </button>
                  )}
                </div>
                {/* The selected joint by name, so a tap in the viewport has a
                    readable result and not only a coloured sphere. */}
                <div className="selected-joint">
                  {selectedJointId ? (
                    <>
                      <span className="selected-joint-dot" aria-hidden="true" />
                      <span className="selected-joint-name">{selectedJointName ?? selectedJointId}</span>
                    </>
                  ) : (
                    <span className="hint">No joint selected. Tap a joint or a row.</span>
                  )}
                </div>
                <div className="bone-tree">
                  {skeleton.bones.length > 0 ? (
                    skeleton.bones.map((bone, i) => <BoneRow key={i} bone={bone} />)
                  ) : (
                    <p className="hint">No bones detected in this model.</p>
                  )}
                </div>
              </section>
            )}
          </>
        )}

        {dockTab === 'display' && (
          <section className="dock-section">
            <span className="section-label">Viewport</span>
            <div className="toggle-list">
              <ToggleRow icon={<MeshIcon />} label="Skin" checked={showMesh} onChange={toggleMesh} />
              <ToggleRow
                icon={<BoneIcon />}
                label="Skeleton"
                checked={showSkeleton}
                onChange={toggleSkeleton}
              />
              <ToggleRow icon={<GridIcon />} label="Grid & ground" checked={showGrid} onChange={toggleGrid} />
            </div>

            <span className="section-label">Motion overlays</span>
            <div className="toggle-list">
              <ToggleRow
                icon={<OnionIcon />}
                label="Onion skin"
                hint="5 ghosted poses behind the playhead"
                checked={showOnionSkin}
                onChange={toggleOnionSkin}
              />
              <ToggleRow
                icon={<TrailIcon />}
                label="Motion trails"
                hint="Per-joint path, last 30 frames"
                checked={showMotionTrail}
                onChange={toggleMotionTrail}
              />
            </div>
            <p className="hint">
              Both overlays draw on the skeleton, so enabling one turns the skeleton on.
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}
