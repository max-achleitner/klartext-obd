/**
 * Everything that reaches the terminal or a text report goes through printable().
 *
 * Device names come from any Bluetooth device in range and adapter replies come from
 * hardware we do not control. Printed raw, they could carry terminal escape sequences
 * (move the cursor, rewrite earlier lines, change the window title) or bidirectional
 * overrides that make text read differently from what it is. Raw values stay available
 * in the JSONL capture, where JSON escaping makes them inert.
 */

// C0 controls except line feed and tab, DEL, C1 controls, and bidirectional formatting.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Replaces characters that a terminal would act on with a visible \u{..} notation. */
export function printable(text: string): string {
  return text.replace(UNSAFE, (char) => `\\u{${char.charCodeAt(0).toString(16).padStart(2, "0")}}`);
}
