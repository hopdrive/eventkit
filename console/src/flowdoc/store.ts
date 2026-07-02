// Flow-doc library: bundled samples fetched from /flows/*.yaml + user uploads
// persisted in localStorage. Until the Console backend exists (D-console-3),
// the SPA reads committed flow docs the same way CI does — as files.

import { parseFlowDoc } from './parseFlowDoc';
import type { FlowDoc } from './types';

const LS_KEY = 'eventkit-console-flowdocs';
const BUNDLED = ['/flows/event-handlers.flow.yaml', '/flows/db-rideshares.flow.yaml'];

export async function loadBundledDocs(): Promise<FlowDoc[]> {
  const docs: FlowDoc[] = [];
  for (const url of BUNDLED) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      docs.push(parseFlowDoc(await res.text(), 'bundled'));
    } catch {
      // bundled samples are best-effort
    }
  }
  return docs;
}

export function loadUploadedDocs(): FlowDoc[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const entries: string[] = JSON.parse(raw);
    return entries.map(text => parseFlowDoc(text, 'uploaded'));
  } catch {
    return [];
  }
}

export function saveUploadedDoc(raw: string): FlowDoc {
  const doc = parseFlowDoc(raw, 'uploaded'); // throws with a readable message if invalid
  const existing = loadUploadedDocs().map(d => d.raw);
  if (!existing.includes(raw)) {
    localStorage.setItem(LS_KEY, JSON.stringify([...existing, raw]));
  }
  return doc;
}

export function removeUploadedDoc(title: string): void {
  const kept = loadUploadedDocs().filter(d => d.title !== title);
  localStorage.setItem(LS_KEY, JSON.stringify(kept.map(d => d.raw)));
}
