import { frames } from '../web-protocol.mjs';
import type { Attachment, Position, RunInfo, TurnData } from './types.ts';
import { ApiError } from './types.ts';

export function operationFields(operation: RunInfo['operation'], target?: Position, parent?: Position) {
  if (operation === 'send') return { metadata: target ? [target.cid, target.rid, target.rcid] : ['', '', ''], operationFlag: undefined };
  if (!target) throw new ApiError('POSITION_UNSUPPORTED');
  return { metadata: [target.cid, parent?.rid ?? '', parent?.rcid ?? ''], operationFlag: operation === 'fork-in-place' ? 2 : 5 };
}

export function attachmentFields(file: Attachment): unknown[] {
  if (Array.isArray(file.reference)) return file.reference;
  const ref = file.reference as { kind?: string; descriptor?: any[] };
  const d = ref?.descriptor;
  if (ref?.kind !== 'history' || !d || typeof d[5] !== 'string' || typeof d[11] !== 'string') throw new ApiError('GENERATION_REJECTED', 'FILE_REFERENCE_UNAVAILABLE', 400);
  // Observed in a native edit after a full page load: history uses an encrypted
  // file token, not the original transient /contrib_service upload reference.
  return [[null, 1, d[1], d[11]], d[2], d[5]];
}

export function parseHistory(raw: string): TurnData[] {
  return parseHistoryPage(raw).turns;
}

export function parseHistoryPage(raw: string): { turns: TurnData[]; nextPageToken: string | null } {
  for (const frame of frames(raw)) {
    if (frame[0] !== 'wrb.fr' || frame[1] !== 'hNvQHb' || typeof frame[2] !== 'string') continue;
    const data = JSON.parse(frame[2]);
    const turns = (data?.[0] ?? []).map((row: any): TurnData | null => {
      const candidates = row?.[3]?.[0] ?? [];
      const chosen = row?.[3]?.[3];
      const c = candidates.find((v: any) => v[0] === chosen) ?? candidates[0];
      if (!c || c[8]?.[0] !== 2) throw new ApiError('UPSTREAM_INCOMPLETE', 'Upstream has an unfinished turn');
      const cid = row[0][0], rid = row[0][1];
      const uploaded = row?.[2]?.[0]?.[3] ?? [];
      const stored = row?.[2]?.[0]?.[4]?.[0]?.[4] ?? row?.[2]?.[0]?.[4]?.[0]?.[3] ?? [];
      const files = uploaded.length ? uploaded.map((f: any) => ({ name: f[1] ?? 'attachment', reference: f }))
        : stored.map((f: any) => ({ name: f[2] ?? 'attachment', size: f[15]?.[2], reference: { kind: 'history', descriptor: f } }));
      return {
        position: { cid, rid, rcid: c[0] },
        input: { text: row?.[2]?.[0]?.[0] ?? '', files },
        output: { text: c[1]?.[0] ?? '' },
        versions: candidates.map((v: any) => ({ cid, rid, rcid: v[0] })),
      };
    }).filter(Boolean).reverse();
    const nextPageToken = data?.[1] || null;
    if (nextPageToken !== null && typeof nextPageToken !== 'string') throw new ApiError('UPSTREAM_HISTORY_INVALID_CURSOR');
    return { turns, nextPageToken };
  }
  throw new ApiError('UPSTREAM_HISTORY_UNAVAILABLE', 'No history response', 502);
}
