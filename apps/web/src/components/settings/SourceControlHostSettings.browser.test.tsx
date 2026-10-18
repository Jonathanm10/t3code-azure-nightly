import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettingsPatch,
  type ServerSettings,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { AzureDevOpsServerSettings } from "@t3tools/shared/azureDevOps";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act } from "react";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const updateSettings = vi.fn();
vi.mock(import("../../state/use-atom-command"), { spy: true });
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
const settingsAtom = Atom.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
let registry: AtomRegistry.AtomRegistry;

import { SourceControlHostSettings } from "./SourceControlHostSettings";

const serverDefinition = {
  ...sourceControlClients.get("azure-devops-server"),
  settings: AzureDevOpsServerSettings,
};
let settings = DEFAULT_SERVER_SETTINGS;
let root: Root;
let container: HTMLDivElement;
const saved = vi.fn();

const button = (name: string) => page.getByRole("button", { name, exact: true });
const input = (name: string) => page.getByRole("textbox", { name, exact: true });
const validationMessage =
  "Use HTTPS collection URLs without credentials or query parameters. Collections and aliases must not overlap.";

const render = () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <SourceControlHostSettings
          environmentId={EnvironmentId.make("env")}
          definition={serverDefinition}
          onSaved={saved}
        />
      </RegistryContext.Provider>,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  registry.set(settingsAtom, DEFAULT_SERVER_SETTINGS);
  vi.spyOn(serverEnvironment, "settingsValueAtom").mockReturnValue(settingsAtom);
  vi.mocked(useAtomCommand).mockReturnValue(updateSettings);
  settings = DEFAULT_SERVER_SETTINGS;
  saved.mockClear();
  updateSettings
    .mockReset()
    .mockImplementation(async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
      settings = applyServerSettingsPatch(settings, input.patch);
      registry.set(settingsAtom, settings);
      return { _tag: "Success" };
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("adds, edits and removes a collection through native host settings, including an empty starting configuration", async () => {
  await render();
  await expect.element(input("API collection URL 1")).not.toBeInTheDocument();
  await userEvent.click(button("Add collection"));
  await userEvent.fill(input("API collection URL 1"), "https://git.example.test:8443/tfs/C");
  await userEvent.fill(input("Browser collection URL 1"), "https://web.example.test/C");
  await userEvent.click(button("Save collections"));
  await expect.poll(() => saved.mock.calls.length).toBe(1);
  expect(settings.sourceControlHosts["azure-devops-server"]).toEqual({
    profiles: [
      {
        apiCollectionUrl: "https://git.example.test:8443/tfs/C",
        browserCollectionUrl: "https://web.example.test/C",
      },
    ],
  });
  await render();
  await expect
    .element(input("API collection URL 1"))
    .toHaveValue("https://git.example.test:8443/tfs/C");
  await expect.element(input("Browser collection URL 1")).toHaveValue("https://web.example.test/C");
  await userEvent.fill(input("API collection URL 1"), "https://git.example.test:8443/tfs/Next");
  await userEvent.click(button("Save collections"));
  await expect.poll(() => saved.mock.calls.length).toBe(2);
  expect(settings.sourceControlHosts["azure-devops-server"]).toEqual({
    profiles: [
      {
        apiCollectionUrl: "https://git.example.test:8443/tfs/Next",
        browserCollectionUrl: "https://web.example.test/C",
      },
    ],
  });
  await render();
  await expect
    .element(input("API collection URL 1"))
    .toHaveValue("https://git.example.test:8443/tfs/Next");
  await userEvent.click(button("Remove"));
  await expect.poll(() => saved.mock.calls.length).toBe(3);
  expect(settings.sourceControlHosts["azure-devops-server"]).toEqual({ profiles: [] });
  await render();
  await expect.element(input("API collection URL 1")).not.toBeInTheDocument();
  await expect.element(button("Remove")).not.toBeInTheDocument();
});

it("rejects credential-bearing or overlapping collection URLs before saving", async () => {
  await render();
  await userEvent.click(button("Add collection"));
  await userEvent.fill(input("API collection URL 1"), "https://user:private@git.example.test/C");
  await userEvent.click(button("Save collections"));
  await expect.element(page.getByRole("alert")).toHaveTextContent(validationMessage);
  expect(updateSettings).not.toHaveBeenCalled();
  await userEvent.fill(input("API collection URL 1"), "https://git.example.test/C");
  await userEvent.click(button("Add collection"));
  await userEvent.fill(input("API collection URL 2"), "https://git.example.test/C/Sub");
  await userEvent.click(button("Save collections"));
  await expect.element(page.getByRole("alert")).toHaveTextContent(validationMessage);
  expect(updateSettings).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
});
