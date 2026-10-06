/** Both Work paths refer to the same confined case output root. No caller path
 * may choose a different filesystem namespace or escape that root. */
export function confinedProfileOutputPath(value: string): string {
  const selected = value
    .replace(/^\/workspace\/outputs\//, "")
    .replace(/^\/workspace\/work\/outputs\//, "")
    .replace(/^outputs\//, "");
  if (
    !selected || selected.startsWith("/") || selected.includes("\0") ||
    selected.split(/[\\/]/).some(part => !part || part === "." || part === "..")
  ) throw new Error("Select one file inside this case's writable outputs.");
  return selected;
}
