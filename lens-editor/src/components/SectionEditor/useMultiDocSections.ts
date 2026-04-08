import { useState, useEffect, useCallback, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { YSweetProvider } from '@y-sweet/client';
import { useDocConnection, type DocConnection } from '../../hooks/useDocConnection';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { parseSections } from './parseSections';
import { interleaveSections, type MultiDocSection } from './interleaveSections';

const USER_COLORS = ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#00ACC1'];

interface DocState {
  doc: Y.Doc;
  provider: YSweetProvider;
  ytext: Y.Text;
  awareness: Awareness;
}

export function useMultiDocSections(compoundDocIds: string[]): {
  sections: MultiDocSection[];
  synced: boolean;
  errors: Map<string, Error>;
} {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const { displayName } = useDisplayName();
  const [docStates, setDocStates] = useState<Map<string, DocState>>(new Map());
  const [sections, setSections] = useState<MultiDocSection[]>([]);
  const [synced, setSynced] = useState(false);
  const [errors, setErrors] = useState<Map<string, Error>>(new Map());
  const observersRef = useRef<Map<string, () => void>>(new Map());

  const uniqueIds = [...new Set(compoundDocIds)];

  // Connect to all docs
  useEffect(() => {
    if (uniqueIds.length === 0) {
      setSynced(true);
      setSections([]);
      return;
    }

    let cancelled = false;

    async function connectAll() {
      const states = new Map<string, DocState>();
      const errs = new Map<string, Error>();

      await Promise.all(uniqueIds.map(async (docId) => {
        try {
          const { doc, provider } = await getOrConnect(docId);
          const ytext = doc.getText('contents');
          const clientId = provider.awareness.clientID;
          provider.awareness.setLocalStateField('user', {
            name: displayName ?? `User ${clientId % 1000}`,
            color: USER_COLORS[clientId % USER_COLORS.length],
          });
          states.set(docId, { doc, provider, ytext, awareness: provider.awareness });
        } catch (err) {
          errs.set(docId, err instanceof Error ? err : new Error(String(err)));
        }
      }));

      if (cancelled) return;
      setDocStates(states);
      setErrors(errs);
      setSynced(true);
    }

    connectAll();
    return () => { cancelled = true; };
  }, [uniqueIds.join(',')]);

  const rebuildSections = useCallback(() => {
    const docSectionsArr = [...docStates.entries()].map(([docId, state], i) => ({
      docIndex: i,
      compoundDocId: docId,
      sections: parseSections(state.ytext.toString()),
    }));
    setSections(interleaveSections(docSectionsArr));
  }, [docStates]);

  // Observe all Y.Texts
  useEffect(() => {
    if (docStates.size === 0) return;
    rebuildSections();
    for (const [docId, state] of docStates) {
      const observer = () => rebuildSections();
      state.ytext.observe(observer);
      observersRef.current.set(docId, observer);
    }
    return () => {
      for (const [docId, observer] of observersRef.current) {
        const state = docStates.get(docId);
        if (state) state.ytext.unobserve(observer);
      }
      observersRef.current.clear();
    };
  }, [docStates, rebuildSections]);

  useEffect(() => {
    return () => disconnectAll();
  }, [disconnectAll]);

  return { sections, synced, errors };
}
