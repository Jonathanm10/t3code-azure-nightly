import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { AzureDevOpsServerSettings } from "@t3tools/shared/azureDevOps";
const serverDefinition = {
  ...sourceControlClients.get("azure-devops-server"),
  settings: AzureDevOpsServerSettings,
};
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { updateSettings } = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: unknown, select: (value: typeof settings) => unknown) =>
    select(settings),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => updateSettings }));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
import { SourceControlHostSettings } from "./SourceControlHostSettings";
let settings = DEFAULT_SERVER_SETTINGS;
let renderer: ReactTestRenderer;
const saved = vi.fn();
const element = () => (
  <SourceControlHostSettings
    environmentId={EnvironmentId.make("env")}
    definition={serverDefinition}
    onSaved={saved}
  />
);
const click = async (label: string) =>
  act(async () => {
    await renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes(label))
      ?.props.onClick();
  });
const fill = async (label: string, value: string) =>
  act(async () => {
    renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } });
  });
beforeEach(() => {
  settings = DEFAULT_SERVER_SETTINGS;
  saved.mockClear();
  updateSettings
    .mockReset()
    .mockImplementation(async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
      settings = applyServerSettingsPatch(settings, input.patch);
      return { _tag: "Success" };
    });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
it("adds, edits and removes a collection through native host settings, including an empty starting configuration", async () => {
  await act(async () => {
    renderer = create(element());
  });
  await click("Add collection");
  await fill("API collection URL 1", "https://git.example.test:8443/tfs/C");
  await fill("Browser collection URL 1", "https://web.example.test/C");
  await click("Save collections");
  expect(settings.sourceControlHosts["azure-devops-server"]).toEqual({
    profiles: [
      {
        apiCollectionUrl: "https://git.example.test:8443/tfs/C",
        browserCollectionUrl: "https://web.example.test/C",
      },
    ],
  });
  await act(async () => renderer.update(element()));
  expect(renderer.root.findByProps({ "aria-label": "API collection URL 1" }).props.value).toBe(
    "https://git.example.test:8443/tfs/C",
  );
  await fill("API collection URL 1", "https://git.example.test:8443/tfs/Next");
  await click("Save collections");
  await act(async () => renderer.update(element()));
  await click("Remove");
  expect(settings.sourceControlHosts["azure-devops-server"]).toEqual({ profiles: [] });
  expect(saved).toHaveBeenCalledTimes(3);
});
it("rejects credential-bearing or overlapping collection URLs before saving", async () => {
  await act(async () => {
    renderer = create(element());
  });
  await click("Add collection");
  await fill("API collection URL 1", "https://user:private@git.example.test/C");
  await click("Save collections");
  expect(updateSettings).not.toHaveBeenCalled();
  await fill("API collection URL 1", "https://git.example.test/C");
  await click("Add collection");
  await fill("API collection URL 2", "https://git.example.test/C/Sub");
  await click("Save collections");
  expect(updateSettings).not.toHaveBeenCalled();
});
