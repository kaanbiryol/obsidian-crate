export interface NotificationPolicy {
  enabled?: boolean;
  folderPath: string;
  /** Encrypted vaults: the folder's sealed name, with `folderPath` as its tag. */
  folderLabel?: string;
  timezone: string;
  allDayTime: string | null;
  revision: string;
}
