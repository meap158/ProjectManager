export interface AntigravityAccount {
  id: string;
  name: string;
  email: string;
  active: boolean;
  plan: string | null;
  usage: { fiveHour: number | null; weekly: number | null; updatedAt: string | null };
}
export interface AntigravityAccountsState {
  available: boolean;
  accounts: AntigravityAccount[];
  defaultAccount?: AntigravityAccount | null;
}
