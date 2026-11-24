/** A random `z-xxxx` task id not used in `text` yet: the format of ui/src/taskchips.ts newTaskId (kept apart, as that module needs the editor). */
export function newTaskId(text: string): string {
  for (;;) {
    const id = `z-${Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (!text.includes(`^${id}`)) return id;
  }
}
