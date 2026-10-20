import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";

/**
 * Everything (bookings, every business's settings and keys, the super admin's settings) lives in one
 * SQLite file, so it survives restarts only if that file is on a persistent disk. Render's own disk
 * outside a mounted volume is wiped on every deploy and restart.
 */
export interface StorageStatus { path: string; persistent: boolean | null; message: string }

export function storageStatus(): StorageStatus {
  const path = resolve(config.databasePath);
  const dir = dirname(path);
  // A mounted disk is a different device from the root filesystem.
  const mounted = existsSync(dir) && statSync(dir).dev !== statSync("/").dev;
  if (mounted) return { path, persistent: true, message: `Saved on a persistent disk (${path}). Settings and bookings survive restarts and deploys.` };
  if (process.env.RENDER) {
    return {
      path, persistent: false,
      message: `Not on a persistent disk (${path}): everything is erased on each restart or deploy. In Render, add a disk to this service with mount path /var/data (it needs a paid instance type).`,
    };
  }
  return { path, persistent: null, message: `Database file: ${path}` };
}

/** A DATABASE_PATH pointing into a folder that doesn't exist almost always means the disk isn't mounted. */
export function assertStorageReady() {
  if (process.env.NODE_ENV === "test") return;
  const dir = dirname(resolve(config.databasePath));
  if (!existsSync(dir)) {
    throw new Error(`The database folder ${dir} doesn't exist. If DATABASE_PATH points at a disk, check the disk is attached and mounted there.`);
  }
}
