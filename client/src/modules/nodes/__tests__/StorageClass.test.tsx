import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { apiMocks } from "../../../ui/mocks/api";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { DefaultStorageClass } from "../StorageClass";

const discovery = apiMocks["GET /api/catalog/discovery"];

describe("DefaultStorageClass", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the one default class", async () => {
    stubApi({
      "GET /api/catalog/discovery": {
        ...discovery,
        basics: discovery.basics.map((b) =>
          b.id === "default-storage-class"
            ? { ...b, status: "ok", found: ["longhorn"], detail: "longhorn is the default" }
            : b
        ),
      },
    });
    renderWithApp(<DefaultStorageClass />);
    expect(await screen.findByText("longhorn")).toBeInTheDocument();
  });

  it("says when two classes claim the default", async () => {
    stubApi();
    renderWithApp(<DefaultStorageClass />);
    expect(await screen.findByText(/2 storage classes are marked default/)).toBeInTheDocument();
  });
});
