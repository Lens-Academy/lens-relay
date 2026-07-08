// turndown-plugin-gfm ships no types. Minimal ambient declaration so the
// server tsconfig typechecks (extract.ts uses only the `gfm` plugin export).
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
