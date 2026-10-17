import type { PullRequestActor } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipPopup: () => null,
}));

import { PullRequestRowAuthor } from "./PullRequestListRow";
import { PullRequestActorLabel } from "./pullRequestPresentation";

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe.each([
  ["list author", PullRequestRowAuthor],
  ["detail and timeline actor", PullRequestActorLabel],
] as const)("%s", (_name, Component) => {
  it.each([
    ["b2b60000-1234-5678-90ab-123456789abc", "Jane Example", "Jane Example", "J"],
    ["octocat", "Jane Example", "octocat", "O"],
    ["b2b60000-1234-5678-90ab-123456789abc", null, "b2b60000-1234-5678-90ab-123456789abc", "B"],
  ])("presents %s without changing its identity", async (login, name, label, initial) => {
    const actor: PullRequestActor = { login, name, avatarUrl: null };
    await act(async () => {
      renderer = create(<Component actor={actor} />);
    });
    const text = renderer.root
      .findAllByType("span")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"));
    expect(text).toContain(label);
    expect(text).toContain(initial);
    expect(actor.login).toBe(login);
  });
});
