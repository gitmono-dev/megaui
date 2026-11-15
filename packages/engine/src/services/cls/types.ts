// megaui:libs/mega/services/cls.ts@0ff3a9d (CreateCLInput)
//
// Diff vs upstream (registered on the EG-05 task card):
// - Scoped to the CL-domain input shape this card implements (list/detail/
//   comments/description/state transitions). `setCLFileViewed` / inline
//   comment / check / dependency-graph input shapes belong to EG-06.
export interface CreateCLInput {
  title: string;
  packageId: string;
  branch: string;
}

export interface CLDescriptionPayload {
  /** Serialized Lexical EditorState JSON (`@megaui/content` empty-doc shape). */
  body: string;
}
