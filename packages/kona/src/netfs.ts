/**
 * §6.1 — refuse to run on a network filesystem.
 *
 * Doing this properly needs `statfs` magic numbers on Linux, `statfs` flags on macOS and
 * `GetDriveType` on Windows, none of which Bun exposes. So: a path heuristic plus a
 * `--force` escape, which is the honest amount of engineering for a risk that shrank when
 * pass one deleted the derived snapshot and with it every atomic rename.
 */

export interface NetworkPathMarker {
  name: string;
  pattern: RegExp;
}

export const NETWORK_PATH_MARKERS: readonly NetworkPathMarker[] = [
  { name: "Dropbox", pattern: /[/\\]Dropbox[/\\]/i },
  { name: "iCloud Drive", pattern: /[/\\]Library[/\\]Mobile Documents[/\\]/ },
  { name: "OneDrive", pattern: /[/\\]OneDrive[^/\\]*[/\\]/i },
  {
    name: "Google Drive",
    pattern: /[/\\](?:Google Drive|My Drive|GoogleDrive|CloudStorage)[/\\]/i,
  },
  // A Windows UNC path is a network share by definition.
  { name: "UNC share", pattern: /^\\\\[^\\]/ },
];

/** Returns the marker that matched, or null. Never throws; a path is just a string. */
export function detectNetworkFilesystem(path: string): NetworkPathMarker | null {
  return NETWORK_PATH_MARKERS.find((marker) => marker.pattern.test(path)) ?? null;
}
