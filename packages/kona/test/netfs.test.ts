import { describe, expect, test } from "bun:test";
import { detectNetworkFilesystem } from "../src/netfs.ts";

describe("network filesystem heuristic (§6.1)", () => {
  test.each([
    ["/Users/ilya/Dropbox/kona", "Dropbox"],
    ["/Users/ilya/Library/Mobile Documents/com~apple~CloudDocs/kona", "iCloud Drive"],
    ["/Users/ilya/OneDrive - Acme/kona", "OneDrive"],
    ["C:\\Users\\ilya\\OneDrive\\kona", "OneDrive"],
    ["/Users/ilya/Google Drive/kona", "Google Drive"],
    ["/Users/ilya/Library/CloudStorage/GoogleDrive-x/kona", "Google Drive"],
    ["\\\\fileserver\\team\\kona", "UNC share"],
  ])("%s is refused as %s", (path, name) => {
    expect(detectNetworkFilesystem(path)?.name).toBe(name);
  });

  test.each([
    "/Users/ilya/Desktop/repos/kona",
    "/tmp/kona",
    "C:\\src\\kona",
    "/Users/ilya/dropbox-notes/kona",
  ])("%s is allowed", (path) => {
    expect(detectNetworkFilesystem(path)).toBeNull();
  });

  test("is a heuristic and says so: it never throws on a strange path", () => {
    expect(detectNetworkFilesystem("")).toBeNull();
  });
});
