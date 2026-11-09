/** Optional local card-to-GitHub automation. Nothing is enabled by default. */
export const cardLinkingKey = (projectId: number) => `card-linking:${projectId}`;
export const CARD_LINK_OUTBOX = 'card-linking-outbox';
export interface CardLinkOptions {
  writeBack: boolean;
}
export interface CardLinkEvent {
  id: string;
  cardId: number;
  projectId: number;
  status: 'review' | 'done';
  url: string;
  at: number;
}
