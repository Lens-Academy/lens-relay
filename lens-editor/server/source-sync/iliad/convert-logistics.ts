/**
 * What on an Iliad page is written for whoever teaches the day, not for the
 * learner. The sync puts it in a `%% ... %%` block, which Lens does not
 * publish. A `<TeachingNote>` says so itself; a timetable is found by its
 * heading.
 */

/** Opens a block Lens will not show to a learner; `%%` on a line of its own closes it. */
export const HIDDEN_OPEN = "%% Facilitator logistics (hidden from learners):";

/**
 * A heading of the day's timetable: "Roadmap for today", "2. Roadmap for the
 * day (as taught in April)", "0.1 Schedule". The hand import of 8 Oct 2026
 * hid each of these and no other section. "Goal and Roadmap" and "Proof
 * roadmap" are content.
 */
export function isLogistics(heading: string): boolean {
  return /^(?:[\d.]+\s+)?(?:roadmap for (?:today|the day)\b.*|schedule)$/i.test(heading.trim());
}

/**
 * True when the lines under a heading hold a timetable and nothing else:
 * table rows or list items with clock times, and notes to the teacher. A
 * subsection of a logistics section is hidden with it only then. One
 * worksheet puts the whole day's reading under "Roadmap for today"; another
 * puts a second timetable there.
 */
export function onlyTimetable(body: string[]): boolean {
  const lines = body
    .join("\n")
    .replace(/<TeachingNote[\s\S]*?<\/TeachingNote>/g, "")
    .split("\n")
    .filter((line) => line.trim());
  return lines.some((line) => /\d{1,2}:\d{2}/.test(line)) && lines.every((line) => /^\s*(?:\||[-*+]\s)/.test(line));
}
