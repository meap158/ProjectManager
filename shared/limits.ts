// Plan usage limits of agent CLIs (PM-17), shared by the API and the client.

/** One rolling usage window, e.g. Codex's 5-hour or weekly limit. */
export interface UsageWindow {
  /** "5-hour" or "Weekly" for the two standard windows, else "<n>-hour" / "<n>-day". */
  label: string;
  windowMinutes: number;
  /** 0–100, as the CLI reported it. */
  usedPercent: number;
  /** ISO time the window resets, when known. */
  resetsAt: string | null;
  /** The reported reset time elapsed; quota remains unconfirmed until a new provider report. */
  resetSinceReport?: boolean;
}

export interface ProviderLimits {
  /** Current account metadata for usage tooltips; never credential material. */
  accountEmail?: string | null;
  accountName?: string | null;
  accountPlan?: string | null;
  providerId: string;
  windows: UsageWindow[];
  /** When the CLI last reported these numbers (they only change while the CLI is used). */
  asOf: string;
  /** Where the numbers come from, for the tooltip. */
  source: string;
}
