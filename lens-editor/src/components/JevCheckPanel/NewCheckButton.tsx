// "New check": asks for an id and a name, creates Lens Edu/Checks/<id> - <name>.md from the
// template (lib/jev-check newCheckText) and opens it. The platform reads every file there.
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { createDocument } from '../../lib/relay-api';
import { newCheckText } from '../../lib/jev-check';
import { RELAY_ID } from '../../App';

const FOLDER = 'Lens Edu';
const DIR = '/Checks';

export function NewCheckButton() {
  const { metadata, folderDocs, onNavigate } = useNavigation();
  const [busy, setBusy] = useState(false);
  async function create() {
    const id = window.prompt('Id of the new check (e.g. T6):')?.trim();
    if (!id) return;
    const name = window.prompt('Short name (what the check catches):')?.trim();
    if (!name) return;
    try {
      const text = newCheckText(id, name);
      const taken = Object.keys(metadata ?? {}).some((p) => p.startsWith(`/${FOLDER}${DIR}/${id} `) || p === `/${FOLDER}${DIR}/${id}.md`);
      if (taken) throw new Error(`a check file for ${id} already exists`);
      const folderDoc = folderDocs.get(FOLDER);
      if (!folderDoc) throw new Error(`${FOLDER} is not loaded`);
      setBusy(true);
      const docId = await createDocument(folderDoc, `${DIR}/${id} - ${name}.md`, 'markdown', text);
      onNavigate(`${RELAY_ID}-${docId}`);
    } catch (e: any) {
      window.alert(`Could not create the check: ${e.message}`);
    } finally { setBusy(false); }
  }
  return (
    <button onClick={create} disabled={busy} className="rounded border border-gray-200 px-2 py-0.5 text-[12px] font-normal text-gray-600 hover:bg-gray-50">
      {busy ? 'Creating…' : '+ New check'}
    </button>
  );
}
