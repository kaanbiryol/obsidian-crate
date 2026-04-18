import type CratePlugin from "./CratePlugin";

export async function ensurePluginDeviceId(plugin: CratePlugin): Promise<void> {
  if (plugin.settings.deviceId) {
    return;
  }

  plugin.settings.deviceId = generateDeviceId();
  await plugin.saveSettings();
}

export function generateDeviceId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  let id = "device-";
  for (const value of bytes) {
    id += chars.charAt(value % chars.length);
  }

  return id;
}
