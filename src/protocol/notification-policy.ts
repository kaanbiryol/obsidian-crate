export interface NotificationPolicy {
  enabled?: boolean;
  folderPath: string;
  timezone: string;
  allDayTime: string | null;
  revision: string;
}
