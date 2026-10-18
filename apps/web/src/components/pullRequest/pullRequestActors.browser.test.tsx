import type { PullRequestActor } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { TooltipProvider } from "../ui/tooltip";
import { PullRequestRowAuthor } from "./PullRequestListRow";
import { PullRequestActorLabel } from "./pullRequestPresentation";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.dataset.testid = "actor-under-test";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each([
  ["list author", PullRequestRowAuthor],
  ["detail and timeline actor", PullRequestActorLabel],
] as const)("%s", (_name, Component) => {
  it.each([
    ["b2b60000-1234-5678-90ab-123456789abc", "Jane Example", "Jane Example", "J", "Jane Example"],
    ["octocat", "Jane Example", "octocat", "O", "Jane Example (@octocat)"],
    [
      "b2b60000-1234-5678-90ab-123456789abc",
      null,
      "b2b60000-1234-5678-90ab-123456789abc",
      "B",
      "b2b60000-1234-5678-90ab-123456789abc",
    ],
  ])("presents %s without changing its identity", async (login, name, label, initial, tooltip) => {
    const actor: PullRequestActor = { login, name, avatarUrl: null };
    await act(async () => {
      root.render(
        <TooltipProvider delay={0}>
          <Component actor={actor} />
        </TooltipProvider>,
      );
    });
    await expect
      .element(page.getByTestId("actor-under-test").getByText(label, { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(initial, { exact: true })).toBeVisible();
    await act(async () =>
      userEvent.hover(page.getByTestId("actor-under-test").getByText(label, { exact: true })),
    );
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-popup"]')?.textContent)
      .toBe(tooltip);
    expect(actor.login).toBe(login);
  });
});
