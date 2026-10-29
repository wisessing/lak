import { useState } from 'react';
import * as THREE from 'three';
import { useStore } from '../store';
import { getActiveEdit, getHasPendingEdit, getWorkingClip } from '../store/derive';
import { applyClipEdit, buildEditedClip, describeEdit } from '../utils/clipEditing';
import {
  baseName,
  buildAnalysisReport,
  buildMotionCsv,
  downloadBlob,
  exportGlb,
  type CsvLayout,
} from '../utils/exporters';
import { exportFbx } from '../utils/fbxExporter';
import { Dialog } from './Dialog';
import { AlertIcon } from './icons';
import './Dialogs.css';

/**
 * Make a typed name safe to hand to a download, without silently renaming it.
 *
 * Strips directory separators and the characters Windows rejects, plus any
 * extension the user typed themselves — otherwise asking for "kick.glb" yields
 * `kick.glb.glb`. An empty result falls back rather than downloading a file
 * called ".glb".
 */
function safeStem(name: string): string {
  const cleaned = name
    .replace(/\.(glb|gltf|fbx|csv|json)$/i, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .trim();
  return cleaned || 'export';
}

/**
 * The app's modals, selected by the store's single `dialog` request.
 *
 * Two, and deliberately not three. Exporting asks "which file do you want?" and
 * the discard guard asks before losing an edit that exists only in memory.
 * *Applying* used to ask too, and should not have: it replaces the working copy,
 * touches no disk, and "Revert to original" undoes it — a confirmation on the
 * app's most-repeated action, guarding nothing.
 */
export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const closeDialog = useStore((s) => s.closeDialog);

  if (!dialog) return null;
  if (dialog.kind === 'discard')
    return (
      <Dialog title="Discard the edit?" onClose={closeDialog} width={400}>
        <div className="dialog-warn">
          <AlertIcon size={18} />
          <p>{dialog.message}</p>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={closeDialog}>
            Keep editing
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              closeDialog();
              dialog.onConfirm();
            }}
          >
            Discard and continue
          </button>
        </div>
      </Dialog>
    );

  return <ExportDialog onClose={closeDialog} />;
}

type Format = 'GLB' | 'FBX' | 'CSV' | 'JSON';

function ExportDialog({ onClose }: { onClose: () => void }) {
  const motion = useStore((s) => s.motion);
  const model = useStore((s) => s.model);
  const fileName = useStore((s) => s.fileName);
  const rootBone = useStore((s) => s.skeleton?.rootBone ?? null);
  const jointMarkers = useStore((s) => s.jointMarkers);
  const applied = useStore((s) => s.applied);
  const sourceClip = useStore((s) => s.sourceClip);
  const editState = useStore((s) => s.editState);
  const setToast = useStore((s) => s.setToast);

  const [layout, setLayout] = useState<CsvLayout>('long');
  const [includeRotations, setIncludeRotations] = useState(false);
  const [includePending, setIncludePending] = useState(true);
  const [busy, setBusy] = useState<Format | null>(null);
  /**
   * `null` until the name is edited, so the suggestion keeps following the
   * source file and the trim suffix. Once typed, the typed name wins — toggling
   * "include the unapplied trim" must not overwrite what someone just entered.
   */
  const [nameOverride, setNameOverride] = useState<string | null>(null);

  const edit = getActiveEdit({ editState, motion });
  const pendingMatters = getHasPendingEdit({ editState, motion });
  const workingClip = getWorkingClip({ applied, sourceClip });
  const usePending = pendingMatters && includePending;

  const stem = baseName(fileName);
  const suffix = usePending ? `_${describeEdit(edit)}` : '';
  const suggested = `${stem}${suffix}`;
  const typed = nameOverride ?? suggested;
  const outName = safeStem(typed);

  const bones =
    ((jointMarkers?.children[0] as THREE.InstancedMesh | undefined)?.userData?.bones as
      | THREE.Bone[]
      | undefined) ?? null;

  if (!motion) return null;

  const data = () => (usePending ? applyClipEdit(motion, edit) : motion);

  // What will actually be written, stated up front. The duration follows the
  // include-pending choice, so toggling that checkbox visibly changes this
  // line before anything is exported. Playback speed never appears here: it is
  // a viewing setting and has no effect on any file.
  const outgoing = data();
  const outFrames = outgoing.frameCount;
  const outSeconds = outgoing.duration;
  const clip = () => {
    if (!workingClip) return null;
    return usePending ? buildEditedClip(workingClip, edit, motion.fps) : workingClip;
  };

  const run = async (format: Format, task: () => Promise<void> | void) => {
    setBusy(format);
    try {
      await task();
      setToast(`${format} exported`);
      onClose();
    } catch (err) {
      console.error(`${format} export failed:`, err);
      setToast(`${format} export failed — ${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const exportScene = (format: 'GLB' | 'FBX') =>
    run(format, async () => {
      if (!model) throw new Error('no model loaded');
      const active = clip();
      if (format === 'GLB') {
        const buffer = await exportGlb(model, active ? [active] : []);
        downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), `${outName}.glb`);
      } else {
        if (!bones || bones.length === 0) throw new Error('no skeleton found');
        const buffer = exportFbx(model, bones, active, {
          fps: motion.fps,
          takeName: stem || 'Take 001',
        });
        downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), `${outName}.fbx`);
      }
    });

  return (
    <Dialog title="Export" onClose={onClose} width={470}>
      <label className="dialog-field">
        <span className="section-label">File name</span>
        <input
          className="field"
          type="text"
          value={typed}
          spellCheck={false}
          autoComplete="off"
          aria-label="Export file name"
          onChange={(e) => setNameOverride(e.target.value)}
        />
      </label>

      <p className="dialog-summary" aria-live="polite">
        {usePending ? 'Exports with the unapplied edit: ' : applied ? 'Exports the applied clip: ' : 'Exports the clip: '}
        <span className="mono">{outSeconds.toFixed(2)}s</span>, <span className="mono">{outFrames}</span> frames at{' '}
        <span className="mono">{motion.fps}</span> fps. Playback speed does not affect exports.
      </p>

      <span className="section-label">Scene</span>
      <div className="format-grid">
        <button
          className="format-card"
          disabled={busy !== null || !model}
          onClick={() => exportScene('FBX')}
        >
          <strong>FBX</strong>
          <span>Mesh, skin, skeleton and animation. For Unity and Blender.</span>
          {busy === 'FBX' && <em>Writing…</em>}
        </button>
        <button
          className="format-card"
          disabled={busy !== null || !model}
          onClick={() => exportScene('GLB')}
        >
          <strong>GLB</strong>
          <span>Same content as glTF binary. Godot's native path.</span>
          {busy === 'GLB' && <em>Writing…</em>}
        </button>
      </div>

      {pendingMatters && (
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={includePending}
            onChange={(e) => setIncludePending(e.target.checked)}
          />
          <span>
            Include the unapplied trim <em className="mono">{describeEdit(edit)}</em>
          </span>
        </label>
      )}

      <details className="dialog-more">
        <summary>Analysis data</summary>
        <div className="dialog-more-body">
          <label className="tl-field">
            <span>CSV layout</span>
            <select
              className="field"
              value={layout}
              onChange={(e) => setLayout(e.target.value as CsvLayout)}
            >
              <option value="long">Long (pandas / R)</option>
              <option value="wide">Wide (Excel)</option>
            </select>
          </label>
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={includeRotations}
              onChange={(e) => setIncludeRotations(e.target.checked)}
            />
            <span>Include rotations</span>
          </label>
          <div className="dialog-actions dialog-actions-left">
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                run('CSV', () => {
                  const csv = buildMotionCsv(data(), { layout, includeRotations });
                  downloadBlob(
                    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
                    `${outName}_motion.csv`
                  );
                })
              }
            >
              CSV
            </button>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                run('JSON', () => {
                  const report = buildAnalysisReport(
                    data(),
                    fileName,
                    rootBone,
                    new Date().toISOString()
                  );
                  downloadBlob(
                    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
                    `${outName}_analysis.json`
                  );
                })
              }
            >
              JSON
            </button>
          </div>
        </div>
      </details>

      <p className="dialog-slug mono">
        {outName}.fbx / .glb
        {nameOverride !== null && nameOverride.trim() !== suggested && (
          <button className="btn-link" type="button" onClick={() => setNameOverride(null)}>
            reset to {suggested}
          </button>
        )}
      </p>
    </Dialog>
  );
}
