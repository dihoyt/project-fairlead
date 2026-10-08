import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockFailedJob, mockRunningJob } from "@contracts/mocks/catalog";
import { apiMocks } from "../../mocks/api";
import { renderWithApp } from "../../../test-utils";
import { DeployJobProgress } from "../DeployJobProgress";
import { WhatIsThis } from "../WhatIsThis";
import { stubApi, stubEventSource } from "./stubApi";

describe("DeployJobProgress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the log of a running job", async () => {
    stubApi({ "GET /api/deploy/jobs/:id": mockRunningJob });
    const { opened } = stubEventSource(["pulling chart", "installing"]);
    renderWithApp(<DeployJobProgress jobId={mockRunningJob.id} />);
    expect(await screen.findByText("running")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("deploy-log")).toHaveTextContent("pulling chart installing"));
    expect(screen.getByText("Following")).toBeInTheDocument();
    expect(opened[0]).toContain(`api/deploy/jobs/${mockRunningJob.id}/logs/stream`);
  });

  it("shows why a job failed with its saved log, and reports it finished once", async () => {
    stubApi({ "GET /api/deploy/jobs/:id": mockFailedJob });
    stubEventSource();
    const onFinished = vi.fn();
    renderWithApp(<DeployJobProgress jobId={mockFailedJob.id} onFinished={onFinished} />);
    expect(await screen.findByText(mockFailedJob.message!)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("deploy-log")).toHaveTextContent("Happy Helming"));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0]![0]).toMatchObject({ state: "failed" });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("cancels a running job", async () => {
    const { calls } = stubApi({ "GET /api/deploy/jobs/:id": mockRunningJob });
    stubEventSource([]);
    renderWithApp(<DeployJobProgress jobId={mockRunningJob.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("cancelled")).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /api/deploy/jobs/:id/cancel")).toBe(true);
  });

  it("reads the log without a stream when not following", async () => {
    stubApi({ "GET /api/deploy/jobs/:id": mockRunningJob });
    const { opened } = stubEventSource();
    renderWithApp(<DeployJobProgress jobId={mockRunningJob.id} follow={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("deploy-log")).toHaveTextContent(apiMocks["GET /api/deploy/jobs/:id/logs"].lines[0]!)
    );
    expect(opened).toHaveLength(0);
  });
});

describe("WhatIsThis", () => {
  it("renders the plain-language line", () => {
    renderWithApp(<WhatIsThis>Backs up your volumes.</WhatIsThis>);
    expect(screen.getByText("Backs up your volumes.")).toBeInTheDocument();
  });
});
