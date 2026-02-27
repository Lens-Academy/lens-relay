import { useState } from 'react';
import type { PanelConfig, PanelManager } from '../hooks/usePanelManager';
import { computeDefaultThresholds } from '../hooks/usePanelManager';

interface Props {
  config: PanelConfig;
  manager: PanelManager;
}

/** Panel IDs in display order */
const PANEL_IDS = ['left-sidebar', 'editor', 'comment-margin', 'right-sidebar', 'discussion'] as const;

function formatThreshold(value: number | 'infinity' | undefined): string {
  if (value === 'infinity') return '\u221E';
  if (value === undefined) return '\u2014';
  return String(Math.round(value));
}

export function PanelDebugOverlay({ config, manager }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded hover:bg-purple-200"
        title="Panel Debug Overlay"
      >
        PD
      </button>
    );
  }

  const debugInfo = manager.getDebugInfo();
  const defaults = computeDefaultThresholds(config, debugInfo.userThresholds);
  const { collapsedState } = manager;

  return (
    <>
      <button
        onClick={() => setIsOpen(false)}
        className="px-2 py-1 text-xs bg-purple-200 text-purple-900 rounded hover:bg-purple-300"
        title="Close Panel Debug Overlay"
      >
        PD
      </button>
      <div
        className="fixed bottom-4 left-4 z-50 bg-gray-900/95 text-gray-100 rounded-lg shadow-xl border border-gray-700 text-xs font-mono"
        style={{ minWidth: 480 }}
      >
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
          <span className="font-bold text-gray-300">Panel Debug</span>
          <button
            onClick={() => setIsOpen(false)}
            className="text-gray-500 hover:text-gray-300 ml-4"
          >
            &times;
          </button>
        </div>
        <div className="px-3 py-2 space-y-2">
          <div className="text-gray-400">
            Viewport: <span className="text-white">{debugInfo.lastWidth}px</span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="pr-3 pb-1 font-normal">Panel</th>
                <th className="pr-3 pb-1 font-normal text-right">Width</th>
                <th className="pr-3 pb-1 font-normal">State</th>
                <th className="pb-1 font-normal">Threshold (eff / def / user)</th>
              </tr>
            </thead>
            <tbody>
              {PANEL_IDS.map(id => {
                const entry = config[id];
                const isCollapsed = collapsedState[id] ?? false;
                const userT = debugInfo.userThresholds.get(id);
                const defaultT = defaults.get(id);

                let width: number;
                if (id === 'editor') {
                  // Editor is flex-1, not tracked — compute from container minus panels
                  let leftSpace = 0;
                  let editorAreaPanelSpace = 0;
                  for (const [pid, pentry] of Object.entries(config)) {
                    if (collapsedState[pid]) continue;
                    if (pentry.group === 'app-outer') {
                      leftSpace += (debugInfo.widths[pid] ?? 0) + 9; // HANDLE_WIDTH
                    } else if (pentry.group === 'editor-area') {
                      editorAreaPanelSpace += (debugInfo.widths[pid] ?? 0) + 9;
                    }
                  }
                  const editorAreaWidth = debugInfo.lastWidth - leftSpace;
                  width = Math.round(Math.max(0, editorAreaWidth - editorAreaPanelSpace - 9));
                } else {
                  width = !entry ? 0 : isCollapsed ? 0 : (debugInfo.widths[id] ?? 0);
                }

                // Effective threshold
                let effectiveT: string;
                if (!entry) {
                  effectiveT = '\u2014';
                } else if (userT === 'infinity') {
                  effectiveT = '\u221E';
                } else if (userT !== undefined) {
                  effectiveT = String(Math.round(userT));
                } else if (defaultT !== undefined) {
                  effectiveT = String(Math.round(defaultT));
                } else {
                  effectiveT = '\u2014';
                }

                const stateLabel = !entry
                  ? '\u2014'
                  : isCollapsed
                    ? 'closed'
                    : 'open';

                const stateColor = !entry
                  ? 'text-gray-600'
                  : isCollapsed
                    ? 'text-red-400'
                    : 'text-green-400';

                return (
                  <tr key={id} className="border-t border-gray-800">
                    <td className="pr-3 py-0.5 text-gray-300">{id}</td>
                    <td className="pr-3 py-0.5 text-right text-white">{Math.round(width)}px</td>
                    <td className={`pr-3 py-0.5 ${stateColor}`}>{stateLabel}</td>
                    <td className="py-0.5 text-gray-400">
                      {entry ? (
                        <>
                          <span className="text-white">{effectiveT}</span>
                          {' / '}
                          {formatThreshold(defaultT)}
                          {' / '}
                          {formatThreshold(userT)}
                        </>
                      ) : (
                        '\u2014'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
