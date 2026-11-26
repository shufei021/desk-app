/**
 * Shared browser controller and face types for the Direct AI page and the image
 * workspace: both plugins mount their own controller over the same generated
 * `directAi` Remote, and this package holds the code neither plugin owns alone.
 */
export { DirectController, validParameters } from './state.ts'
export type {
  AssistChat, AssistOutcome, CatalogState, DirectoryState, DirectRemote, HistoryState, InteractionState, ShownRun,
} from './state.ts'
export { imageParamFacts } from './image-param-facts.ts'
export type { ImageParamFacts } from './image-param-facts.ts'
export { pageFace } from './face.ts'
export type { DirectPageInjected } from './face.ts'
