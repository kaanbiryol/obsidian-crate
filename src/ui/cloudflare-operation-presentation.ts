import type { DeploymentIntent } from '../cloudflare/deployment-types';
import type { ConnectionTestResult } from '../sync/types';
import type { CloudflareDeploymentModal } from './cloudflare-deployment-modal';

type Progress = Pick<CloudflareDeploymentModal, 'setWorking' | 'fail' | 'succeed'>;
interface OperationContext {
  intent: DeploymentIntent | null;
  shouldConnectDevice: boolean;
  openSettings: () => void;
  recoverUpdate: () => void;
}

/** Presentation only: authorization, target checks and service dispatch stay with the caller. */
export class CloudflareOperationPresentation {
  constructor(private progress: Progress, private context: OperationContext) {}

  start(): void {
    if (this.context.intent === 'delete') this.progress.setWorking('Deleting Crate server', 'Verifying this server, then removing its remote data and Worker. Keep Obsidian open.');
    if (this.context.intent === 'reset') this.progress.setWorking('Rebuilding Crate server', 'Verifying this deployment, then erasing its remote data and rebuilding. Keep Obsidian open.');
  }

  checkingAccess(): void { this.progress.setWorking('Reconnecting', 'Checking this device’s access…'); }

  advance(message: string): void {
    const { intent, shouldConnectDevice } = this.context;
    this.progress.setWorking(intent === 'reconnect' ? 'Reconnecting' : intent === 'reset' ? 'Rebuilding Crate server'
      : intent === 'delete' ? 'Deleting Crate server' : shouldConnectDevice ? 'Setting up Crate' : 'Updating Crate server', message);
  }

  authorizationFailed(message: string): void {
    this.progress.fail('Could not connect to Cloudflare', message, ['Try again from Crate settings.']);
  }

  operationFailed(message: string, recovery: { needsReview: boolean; canResumeDeletion: boolean; resetBlocked: boolean }): void {
    const { intent, shouldConnectDevice, openSettings, recoverUpdate } = this.context;
    const deleteAction = recovery.canResumeDeletion ? 'Resume server deletion' : 'Delete server and all data';
    if (recovery.needsReview) {
      this.progress.fail(
        'Server operation needs review',
        'Crate couldn’t confirm whether Cloudflare finished the operation. Further server changes are blocked to prevent overlapping updates.',
        [
          'If another device is updating this server, let it finish.',
          intent === 'delete'
            ? `Once your connection is stable, open Crate settings → Advanced server actions and select ${deleteAction}. Crate will check the interrupted step before continuing. If it still needs review, keep the technical details for support.`
            : 'If the operation was interrupted, its Cloudflare status must be checked and the update lock recovered before trying again.',
          'Closing this message does not clear the lock.',
        ],
        { technicalDetails: message, action: intent === 'reset' || intent === 'delete'
          ? { label: 'Open settings', onClick: openSettings }
          : { label: 'Check and recover update', onClick: recoverUpdate } },
      );
      return;
    }
    if (intent === 'delete') {
      this.progress.fail('Server deletion failed', 'Crate couldn’t finish deleting your Cloudflare server.',
        [`Once your connection is stable, open Crate settings → Advanced server actions and select ${deleteAction} to check and continue.`],
        { technicalDetails: message, action: { label: 'Open settings', onClick: openSettings } });
      return;
    }
    if (intent === 'reset') {
      this.progress.fail('Server rebuild failed', 'Crate couldn’t finish rebuilding your Cloudflare server.',
        [recovery.resetBlocked
          ? 'Review the technical details below. The reported issue must be resolved before rebuilding this server.'
          : 'This rebuild was started by an earlier Crate version. Complete recovery using that version before changing this connection. Keep this vault’s saved settings.'],
        { technicalDetails: message, action: { label: 'Open settings', onClick: openSettings } });
      return;
    }
    this.progress.fail(
      shouldConnectDevice
        ? intent === 'reconnect' ? 'Could not reconnect' : 'Could not prepare your Cloudflare server'
        : 'Could not update your Cloudflare server',
      message,
      [shouldConnectDevice
        ? intent === 'reconnect' ? 'Select “Reconnect” in Crate settings to try again.' : 'Select “Connect with Cloudflare” in Crate settings to start again.'
        : 'Select “Update server” in Crate settings to try again.'],
    );
  }

  deleted(): void {
    this.progress.succeed('Crate server deleted', 'This server and its remote data have been removed. Your local vault files are kept. To sync again, select Connect with Cloudflare, create a new server, then select Crate: Sync - sync now.');
  }

  updated(): void { this.progress.succeed('Cloudflare server updated', 'Your Worker and Crate web app are now up to date.'); }

  connecting(): void {
    this.progress.setWorking('Connecting this device', this.context.intent === 'reconnect'
      ? 'Verifying this device’s connection. Keep Obsidian open.' : 'Creating a private credential for this device. Keep Obsidian open.');
  }

  connectionFailed(message: string): void {
    this.progress.fail('Could not connect this device', message,
      [this.context.intent === 'reconnect' ? 'Select “Reconnect” in Crate settings to try again.' : 'Select “Connect with Cloudflare” in Crate settings to try again.']);
  }

  connected(connection: ConnectionTestResult): void {
    const { intent, openSettings } = this.context;
    if (!connection.success) {
      if (connection.code === 'incompatible_protocol') {
        this.progress.fail('Crate server is incompatible', `Sync is unavailable: ${connection.error}.`, [
          'Reconnecting keeps the existing server version. To keep its remote data, use a matching plugin build and its recovery instructions.',
          'For a fresh start, open Crate settings → Advanced server actions → Delete server and all data. After deletion, select Connect with Cloudflare and create a new server. Your local vault files are kept.',
        ], { action: { label: 'Open settings', onClick: openSettings } });
      } else {
        this.progress.fail('Crate is connected with a warning', `The connection test failed: ${connection.error ?? 'Unknown error'}`,
          ['Your device credentials were saved. You can retry the connection test from Crate settings.']);
      }
      return;
    }
    this.progress.succeed(
      intent === 'reconnect' ? 'Connection verified' : intent === 'reset' ? 'Crate server rebuilt' : 'Crate is connected',
      intent === 'reconnect' ? 'Cloudflare and this device are connected. Select Sync now to retry syncing.'
        : intent === 'reset' ? 'This device is connected. Open the command palette and select Crate: Sync - sync now to sync this vault with the server. Reconnect other devices and set up web push again.'
        : 'Connected. Open the command palette and select Crate: Sync - sync now to sync this vault with the server.',
    );
  }
}
