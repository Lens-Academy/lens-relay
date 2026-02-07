// src/components/Editor/extensions/index.ts
// Central export file for all editor extensions

export {
  criticMarkupExtension,
  criticMarkupField,
  toggleSuggestionMode,
  suggestionModeField,
  criticMarkupCompartment,
} from './criticmarkup';

export {
  acceptChangeAtCursor,
  rejectChangeAtCursor,
  criticMarkupKeymap,
} from './criticmarkup-commands';

export {
  getContextMenuItems,
  type ContextMenuItem,
} from './criticmarkup-context-menu';

export { livePreview, toggleSourceMode, livePreviewCompartment } from './livePreview';
