import type { Action, ActionResult, Input, WorldView } from '../core/types'
import type { tutorialProgress } from '../core/index'

export type LessonProgress = ReturnType<typeof tutorialProgress>
export type TutorialRequest =
  | { type: 'start'; lesson: number; saved: string | null }
  | { type: 'input'; value: Input; sentAt: number }
  | { type: 'action'; id: string; value: Action }
  | { type: 'consumed'; sequence: number }
  | { type: 'close' }
export type TutorialResponse =
  | { type: 'view'; sequence: number; view: WorldView; progress: LessonProgress; saved: string; checkpoint: boolean }
  | { type: 'receipt'; id: string; result: ActionResult; saved: string }
  | { type: 'closed'; saved: string }
  | { type: 'failed' }
