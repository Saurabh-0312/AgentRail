/**
 * The live attack's results, shared between the button and the evidence rows on the same page:
 * each `attack` event the stream delivers lands here the moment it arrives, so the recorded row
 * for that attack can show the fresh signature beside the 10 Sept one. In-memory, per tab, cleared
 * at the start of every run. Nothing here is persisted or sent anywhere.
 */
import { useSyncExternalStore } from "react";

export interface LiveMark {
  id: string;
  status: "refused" | "refused-other" | "aborted" | "inconclusive" | "SUCCEEDED";
  errorCode: number | null;
  errorName: string | null;
  signature: string | null;
  explorer: string | null;
  /** When the browser received the verdict (ISO). */
  at: string;
}

const EMPTY: Readonly<Record<string, LiveMark>> = Object.freeze({});
let marks: Readonly<Record<string, LiveMark>> = EMPTY;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export function setLiveMark(m: LiveMark) {
  marks = { ...marks, [m.id]: m };
  notify();
}

export function clearLiveMarks() {
  marks = EMPTY;
  notify();
}

export function useLiveMarks(): Readonly<Record<string, LiveMark>> {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => marks,
    () => EMPTY,
  );
}
