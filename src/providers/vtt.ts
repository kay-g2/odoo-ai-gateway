/** WebVTT output for `1/get_transcription` with `response_format: "vtt"` (call recordings). */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function vttTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}

export function buildVtt(cues: Cue[]): string {
  const blocks = cues
    .filter((cue) => cue.text.trim())
    .map((cue, index) => `${index + 1}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(Math.max(cue.end, cue.start))}\n${cue.text.trim()}`);
  return `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

/** Group word timings into cues of at most `maxWords` words / `maxSeconds` seconds. */
export function cuesFromWords(words: Array<{ text: string; start: number; end: number }>, maxWords = 12, maxSeconds = 6): Cue[] {
  const cues: Cue[] = [];
  let current: Cue | null = null;
  let count = 0;
  for (const word of words) {
    if (!current || count >= maxWords || word.end - current.start > maxSeconds) {
      if (current) cues.push(current);
      current = { start: word.start, end: word.end, text: word.text.trim() };
      count = 1;
    } else {
      current.end = word.end;
      current.text = /^[,.;:!?%)]/.test(word.text.trim()) ? `${current.text}${word.text.trim()}` : `${current.text} ${word.text.trim()}`;
      count += 1;
    }
  }
  if (current) cues.push(current);
  return cues;
}

/**
 * Fallback when a model returns text without timings: one cue covering the recording.
 * `durationSeconds` defaults to a large bound so the whole text stays visible.
 */
export function singleCueVtt(text: string, durationSeconds?: number): string {
  return buildVtt([{ start: 0, end: durationSeconds && durationSeconds > 0 ? durationSeconds : 359_999.999, text }]);
}

/** Heuristic: already a WebVTT document. */
export function isVtt(text: string): boolean {
  return /^﻿?WEBVTT/.test(text.trimStart());
}
