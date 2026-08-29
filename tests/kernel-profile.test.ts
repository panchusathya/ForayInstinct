import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProfile: vi.fn<() => Promise<{ id: string }>>(),
  retrieveProfile: vi.fn<() => Promise<{ id: string }>>(),
  deleteProfile: vi.fn<() => Promise<unknown>>(),
  readWorkspaceKernelProfileId: vi.fn<() => Promise<string>>(),
  saveWorkspaceKernelProfileId: vi.fn<() => Promise<{ stored: boolean }>>(),
  ensureScope: vi.fn(async () => undefined),
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    profiles: {
      create: mocks.createProfile,
      retrieve: mocks.retrieveProfile,
      delete: mocks.deleteProfile,
    },
  },
}));

vi.mock("@/db/services/scope", () => ({
  ensureScope: mocks.ensureScope,
}));

vi.mock("@/db/services/workspaces", () => ({
  readWorkspaceKernelProfileId: mocks.readWorkspaceKernelProfileId,
  saveWorkspaceKernelProfileId: mocks.saveWorkspaceKernelProfileId,
}));

import {
  deleteKernelBrowserProfile,
  kernelProfileName,
} from "../lib/manager/server/kernel-profile";

const scope = { userId: "user-1", workspaceId: "personal:deadbeef" };

describe("Kernel browser profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspaceKernelProfileId.mockResolvedValue("profile-1");
    mocks.saveWorkspaceKernelProfileId.mockResolvedValue({ stored: true });
    mocks.deleteProfile.mockResolvedValue({});
  });

  it("names the profile from the workspace id suffix", () => {
    expect(kernelProfileName("personal:abc123def")).toBe("foray-abc123def");
    expect(kernelProfileName("personal:not valid!")).toBe("foray-notvalid");
  });

  it("fails closed when Kernel cannot delete the saved profile", async () => {
    mocks.deleteProfile.mockRejectedValue(new Error("kernel 500"));

    await expect(deleteKernelBrowserProfile(scope)).rejects.toThrow("kernel 500");
    expect(mocks.saveWorkspaceKernelProfileId).not.toHaveBeenCalled();
  });

  it("clears the stored id after a 404 delete", async () => {
    mocks.deleteProfile.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));

    await deleteKernelBrowserProfile(scope);

    expect(mocks.saveWorkspaceKernelProfileId).toHaveBeenCalledWith(scope, "");
  });

  it("fails closed when the local id cannot be cleared", async () => {
    mocks.saveWorkspaceKernelProfileId.mockResolvedValue({ stored: false });

    await expect(deleteKernelBrowserProfile(scope)).rejects.toThrow(
      "could not be cleared locally"
    );
  });
});
